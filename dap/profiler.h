/**
 * Function-timing profiler for the SourcePawn console debugger.
 *
 * The SourcePawn VM only emits IProfilingTool EnterScope/LeaveScope at top-level
 * Invoke() (one scope per public call), so it can't show which functions a
 * function called. To get a real call tree we instead TRACE: the per-line
 * debug-break hook (ConsoleDebugger::MaybeRecordProfileSample) diffs the current
 * scripted call stack against the previous break and drives EnterScope (on a new
 * call) / LeaveScope (on return) here. That reuses this tool's exact bookkeeping
 * -- inclusive time + real call counts -- to build a full per-call-path tree.
 * The VS Code side renders total / self / calls (self = total - sum(children),
 * avg self/call = self/calls).
 *
 * IMPORTANT: EnterScope/LeaveScope run on the VM (main) thread; the readout
 * (SerializeJson/Reset/FlushOpenScopes) runs on the TCP thread, so the tree is
 * mutex-guarded. Profiling never pauses the VM.
 *
 * Each node's group is the owning plugin's ".smx" name (per frame), so the
 * VS Code "this plugin only" vs "all plugins" filter works on the same capture.
 */
#ifndef _INCLUDE_SP_PROFILER_H
#define _INCLUDE_SP_PROFILER_H

#include <sp_vm_api.h>
#include <string>
#include <vector>
#include <utility>
#include <memory>
#include <map>
#include <mutex>
#include <chrono>
#include <cstdint>
#include <atomic>

// Upper bounds on what one capture keeps. Samples are run-length merged before
// they land here (consecutive breaks in the same function collapse into one),
// so these are generous in practice; both carry a "truncated" flag to the client
// rather than silently lying about the capture.
constexpr size_t kMaxProfileSamples = 120000;
constexpr size_t kMaxProfileSpans = 100000;
// Per-call self times kept per node for the p95 estimate. Beyond this the node
// keeps min/max/mean exactly and the percentile is drawn from the first N.
constexpr size_t kMaxCallSamplesPerNode = 512;

// One node in the call tree, identified by (group, name) under its parent.
struct ProfileNode {
  std::string group;
  std::string name;
  uint64_t total_ns = 0;   // kInclusiveSpan: inclusive time (Enter->Leave span)
  uint64_t self_ns = 0;    // kSelfGap: exclusive time (continuous-execution gaps)
  uint64_t calls = 0;
  // Per-call distribution of self time: the difference between "one 40ms call"
  // and "4000 calls of 10us", which totals alone cannot express.
  uint64_t min_call_ns = 0;
  uint64_t max_call_ns = 0;
  uint64_t stat_calls = 0;                 // calls that contributed to the stats
  std::vector<uint64_t> call_self_samples; // capped; feeds the p95 estimate
  // Self time per source line, so the hot LINE inside a function is visible.
  // This is also how native cost shows up: the VM exposes no native-level
  // scopes, so a native's time lands on the line that called it -- naming that
  // line is the closest honest attribution available.
  std::map<uint32_t, uint64_t> line_self_ns;
  uint32_t id = 0;         // assigned during serialization; referenced by samples/spans
  std::vector<std::unique_ptr<ProfileNode>> children;

  ProfileNode* FindOrAddChild(const char* group, const char* name);
  void RecordCall(uint64_t self_ns_for_this_call);
};

// One recorded execution sample: "this node was on top for the next dt_ns".
// Consecutive samples of the same node are merged, so this is a run-length
// encoding of the real timeline -- not the synthetic, fixed-interval one the
// .cpuprofile writer used to invent.
struct ProfileSample {
  ProfileNode* node;
  uint64_t start_ns;   // relative to capture start
  uint64_t dt_ns;
};

// One call, with its real begin/end. Exported as a Chrome Trace Event span so a
// capture can be opened on a timeline (Perfetto / chrome://tracing) and read
// tick by tick, which no aggregated flame graph can show.
struct ProfileSpan {
  ProfileNode* node;
  uint64_t start_ns;   // relative to capture start
  uint64_t end_ns;
  uint32_t depth;
};

class Profiler : public SourcePawn::IProfilingTool {
public:
  // How a node's time is accounted:
  //  - kInclusiveSpan: the VM's IProfilingTool path -- EnterScope timestamps,
  //    LeaveScope credits the elapsed inclusive span to total_ns. Used by the
  //    "all plugins" (vm) profiler, driven natively at Invoke() boundaries, so
  //    the span is real wall time.
  //  - kSelfGap: the debug-break tracer path -- the caller credits each node's
  //    *exclusive* time directly via CreditSelfToTop() (the real gap between
  //    consecutive breaks while that function was on top). LeaveScope only counts
  //    the call. Inclusive time is derived as self + sum(children). This lets the
  //    tracer EXCLUDE the idle gap between server frames (which otherwise inflates
  //    a top-level forward to ~= the whole capture window).
  enum class Timing { kInclusiveSpan, kSelfGap };

  explicit Profiler(Timing timing = Timing::kInclusiveSpan) : timing_(timing) {}

  // --- IProfilingTool ------------------------------------------------------
  const char* Name() override { return "sp-debugger"; }
  const char* Description() override { return "VS Code SourcePawn function profiler"; }
  void RenderHelp(void (*render)(const char* fmt, ...)) override {}
  bool Start() override { active_ = true; return true; }
  void Stop(void (*render)(const char* fmt, ...)) override { active_ = false; }
  void Dump() override {}
  bool IsActive() override { return active_; }
  bool IsAttached() override { return true; }
  void EnterScope(const char* group, const char* name) override;
  void LeaveScope() override;

  // kSelfGap only: credit `ns` of exclusive time to the node currently on top of
  // the stack (the function that was executing during the just-elapsed gap) and
  // record it on the timeline. `line` is the source line that was executing
  // during that gap (0 when unknown). No-op if the stack is empty. Called from
  // the VM-thread break hook.
  void CreditSelfToTop(uint64_t ns, uint32_t line = 0);

  // Monotonic count of top-level Invoke() entries the VM has driven into this
  // tool (incremented whenever EnterScope opens a scope on an empty stack, i.e.
  // the "EnterJIT" that begins each Invoke). The kSelfGap tracer reads this off
  // the *vm* profiler to know, EXACTLY, whether the VM left the plugin and
  // re-entered between two breaks: if the seq changed, the gap was time spent
  // outside the current call (another Invoke / engine code between per-player
  // OnPlayerRunCmd calls / the next frame) and must NOT be credited.
  uint64_t InvokeSeq() const { return invoke_seq_.load(std::memory_order_relaxed); }

  // --- control / readout (TCP thread) --------------------------------------
  // Close any scopes still open, so their inclusive time is finalized in the
  // tree before SerializeJson(). The spans they emit are stamped at `end_time`:
  // a return is only NOTICED at the next break, so stamping "now" would stretch
  // the slice across the idle in between and make the timeline read as if the
  // plugin had been running the whole time. Callers pass the last instant the
  // plugin was known to be executing.
  void FlushOpenScopes();
  void FlushOpenScopesAt(std::chrono::steady_clock::time_point end_time);
  // Clear all accumulated data and the active stack.
  void Reset();
  // Snapshot the current tree as a JSON object:
  //   {"tree":{...}, "samples":{...}, "spans":{...}}
  // The tree carries per-node totalMs/selfMs/calls, the per-call distribution
  // (min/max/p95 of self) and the hot-line breakdown; samples and spans carry
  // the measured timeline. Safe to call while profiling.
  std::string SerializeJson();

private:
  struct Frame {
    ProfileNode* node;
    std::chrono::steady_clock::time_point start;
    uint64_t start_rel_ns = 0;      // capture-relative, for the span export
    uint64_t self_this_call_ns = 0; // feeds the per-call distribution
  };

  // Appends this node's JSON and returns its inclusive time in ns (so the parent
  // can roll children up). The inclusive/self split depends on timing_.
  uint64_t SerializeNode(const ProfileNode* node, std::string& out);

  // Number the tree depth-first so samples/spans can reference nodes by id.
  void AssignIdsLocked(ProfileNode* node, uint32_t* next_id);

  // Record `dt_ns` of execution for `node` on the timeline, merging into the
  // previous sample when it is the same node. Caller holds mutex_.
  void RecordSampleLocked(ProfileNode* node, uint64_t dt_ns);

  std::mutex mutex_;
  ProfileNode root_;            // sentinel; its children are top-level calls
  std::vector<Frame> stack_;    // active call stack
  std::chrono::steady_clock::time_point capture_start_{};
  std::vector<ProfileSample> samples_;
  std::vector<ProfileSpan> spans_;
  uint64_t sampled_ns_ = 0;     // running clock for run-length sample starts
  bool samples_truncated_ = false;
  bool spans_truncated_ = false;
  bool active_ = false;
  Timing timing_;
  // Bumped on each top-level EnterScope (one per Invoke). Read cross-purpose by
  // the tracer; written on the VM thread, reset on the TCP thread -> atomic.
  std::atomic<uint64_t> invoke_seq_{0};
};

#endif // _INCLUDE_SP_PROFILER_H
