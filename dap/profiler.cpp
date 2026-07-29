#include "profiler.h"
#include "json-utils.h"
#include <algorithm>
#include <cstdio>

ProfileNode* ProfileNode::FindOrAddChild(const char* g, const char* n) {
  const char* gs = g ? g : "";
  const char* ns = n ? n : "";
  for (auto& c : children) {
    if (c->name == ns && c->group == gs)
      return c.get();
  }
  auto child = std::make_unique<ProfileNode>();
  child->group = gs;
  child->name = ns;
  ProfileNode* raw = child.get();
  children.push_back(std::move(child));
  return raw;
}

void ProfileNode::RecordCall(uint64_t self_ns_for_this_call) {
  if (stat_calls == 0 || self_ns_for_this_call < min_call_ns)
    min_call_ns = self_ns_for_this_call;
  if (self_ns_for_this_call > max_call_ns)
    max_call_ns = self_ns_for_this_call;
  stat_calls++;
  if (call_self_samples.size() < kMaxCallSamplesPerNode)
    call_self_samples.push_back(self_ns_for_this_call);
}

void Profiler::EnterScope(const char* group, const char* name) {
  std::lock_guard<std::mutex> lock(mutex_);
  // A scope opened on an empty stack is the top of a fresh Invoke (the VM's
  // "EnterJIT"). Count it so the tracer can detect Invoke boundaries exactly.
  if (stack_.empty())
    invoke_seq_.fetch_add(1, std::memory_order_relaxed);
  ProfileNode* parent = stack_.empty() ? &root_ : stack_.back().node;
  ProfileNode* node = parent->FindOrAddChild(group, name);
  auto now = std::chrono::steady_clock::now();
  Frame frame;
  frame.node = node;
  frame.start = now;
  frame.start_rel_ns = static_cast<uint64_t>(
      std::chrono::duration_cast<std::chrono::nanoseconds>(now - capture_start_).count());
  stack_.push_back(frame);
}

void Profiler::LeaveScope() {
  std::lock_guard<std::mutex> lock(mutex_);
  if (stack_.empty())
    return;  // unbalanced (shouldn't happen) -- ignore
  Frame f = stack_.back();
  stack_.pop_back();
  auto now = std::chrono::steady_clock::now();
  // kInclusiveSpan: the Enter->Leave wall span is real (VM Invoke boundary).
  // kSelfGap: time is credited per break via CreditSelfToTop, so Leave only
  // counts the call (crediting the span here would re-add the between-frame idle
  // that this model exists to exclude).
  if (timing_ == Timing::kInclusiveSpan) {
    f.node->total_ns +=
        std::chrono::duration_cast<std::chrono::nanoseconds>(now - f.start).count();
  }
  f.node->calls += 1;
  f.node->RecordCall(f.self_this_call_ns);

  if (spans_.size() < kMaxProfileSpans) {
    const uint64_t end_rel = static_cast<uint64_t>(
        std::chrono::duration_cast<std::chrono::nanoseconds>(now - capture_start_).count());
    spans_.push_back(ProfileSpan{f.node, f.start_rel_ns, end_rel,
                                 static_cast<uint32_t>(stack_.size())});
  } else {
    spans_truncated_ = true;
  }
}

void Profiler::RecordSampleLocked(ProfileNode* node, uint64_t dt_ns) {
  // Run-length merge: a function usually executes many consecutive lines, and
  // one entry per break would bloat the capture without adding information.
  if (!samples_.empty() && samples_.back().node == node) {
    samples_.back().dt_ns += dt_ns;
    sampled_ns_ += dt_ns;
    return;
  }
  if (samples_.size() >= kMaxProfileSamples) {
    samples_truncated_ = true;
    sampled_ns_ += dt_ns;
    return;
  }
  samples_.push_back(ProfileSample{node, sampled_ns_, dt_ns});
  sampled_ns_ += dt_ns;
}

void Profiler::CreditSelfToTop(uint64_t ns, uint32_t line) {
  std::lock_guard<std::mutex> lock(mutex_);
  if (stack_.empty())
    return;
  Frame& top = stack_.back();
  top.node->self_ns += ns;
  top.self_this_call_ns += ns;
  if (line != 0)
    top.node->line_self_ns[line] += ns;
  RecordSampleLocked(top.node, ns);
}

void Profiler::FlushOpenScopes() {
  FlushOpenScopesAt(std::chrono::steady_clock::now());
}

void Profiler::FlushOpenScopesAt(std::chrono::steady_clock::time_point end_time) {
  std::lock_guard<std::mutex> lock(mutex_);
  // Close any scopes still open (capture stopped mid-call, or the VM left the
  // plugin): credit their time so the tree's totals are final. Same accounting
  // split as LeaveScope.
  auto now = end_time;
  const uint64_t end_rel = static_cast<uint64_t>(
      std::chrono::duration_cast<std::chrono::nanoseconds>(now - capture_start_).count());
  while (!stack_.empty()) {
    Frame f = stack_.back();
    stack_.pop_back();
    if (timing_ == Timing::kInclusiveSpan) {
      auto elapsed = now - f.start;
      f.node->total_ns +=
          std::chrono::duration_cast<std::chrono::nanoseconds>(elapsed).count();
    }
    f.node->calls += 1;
    f.node->RecordCall(f.self_this_call_ns);
    if (spans_.size() < kMaxProfileSpans) {
      spans_.push_back(ProfileSpan{f.node, f.start_rel_ns, end_rel,
                                   static_cast<uint32_t>(stack_.size())});
    } else {
      spans_truncated_ = true;
    }
  }
}

void Profiler::Reset() {
  std::lock_guard<std::mutex> lock(mutex_);
  root_.children.clear();
  root_.total_ns = 0;
  root_.self_ns = 0;
  root_.calls = 0;
  stack_.clear();
  samples_.clear();
  spans_.clear();
  sampled_ns_ = 0;
  samples_truncated_ = false;
  spans_truncated_ = false;
  capture_start_ = std::chrono::steady_clock::now();
  invoke_seq_.store(0, std::memory_order_relaxed);
}

// p95 of the retained per-call self times, in nanoseconds. Returns 0 when the
// node has no recorded calls.
static uint64_t Percentile95(std::vector<uint64_t> values) {
  if (values.empty())
    return 0;
  std::sort(values.begin(), values.end());
  size_t idx = static_cast<size_t>(values.size() * 0.95);
  if (idx >= values.size())
    idx = values.size() - 1;
  return values[idx];
}

uint64_t Profiler::SerializeNode(const ProfileNode* node, std::string& out) {
  // Serialize children first so we know their summed inclusive time, then derive
  // this node's inclusive/self split from it (model-dependent).
  std::string child_json;
  uint64_t children_incl_ns = 0;
  for (size_t i = 0; i < node->children.size(); i++) {
    if (i) child_json += ",";
    children_incl_ns += SerializeNode(node->children[i].get(), child_json);
  }

  uint64_t incl_ns, self_ns;
  if (timing_ == Timing::kSelfGap) {
    // self is measured directly (break gaps); inclusive = self + children.
    self_ns = node->self_ns;
    incl_ns = self_ns + children_incl_ns;
  } else {
    // inclusive is measured (Enter->Leave span); self = inclusive - children.
    incl_ns = node->total_ns;
    self_ns = (incl_ns > children_incl_ns) ? (incl_ns - children_incl_ns) : 0;
  }

  char nums[320];
  snprintf(nums, sizeof(nums),
           "\"id\":%u,\"totalMs\":%.4f,\"selfMs\":%.4f,\"calls\":%llu,"
           "\"minSelfMs\":%.4f,\"maxSelfMs\":%.4f,\"p95SelfMs\":%.4f",
           node->id, incl_ns / 1.0e6, self_ns / 1.0e6,
           (unsigned long long)node->calls,
           node->min_call_ns / 1.0e6, node->max_call_ns / 1.0e6,
           Percentile95(node->call_self_samples) / 1.0e6);

  out += "{\"name\":\"";
  out += JsonParser::EscapeString(node->name);
  out += "\",\"group\":\"";
  out += JsonParser::EscapeString(node->group);
  out += "\",";
  out += nums;

  // Hot lines, heaviest first. The client turns these into .cpuprofile
  // positionTicks, which is what makes the flame chart show per-line heat.
  if (!node->line_self_ns.empty()) {
    std::vector<std::pair<uint32_t, uint64_t>> lines(node->line_self_ns.begin(),
                                                     node->line_self_ns.end());
    std::sort(lines.begin(), lines.end(),
              [](const std::pair<uint32_t, uint64_t>& a, const std::pair<uint32_t, uint64_t>& b) {
                return a.second > b.second;
              });
    out += ",\"lines\":[";
    for (size_t i = 0; i < lines.size(); i++) {
      if (i) out += ",";
      char buf[96];
      snprintf(buf, sizeof(buf), "{\"line\":%u,\"selfMs\":%.4f}", lines[i].first,
               lines[i].second / 1.0e6);
      out += buf;
    }
    out += "]";
  }

  out += ",\"children\":[";
  out += child_json;
  out += "]}";
  return incl_ns;
}

void Profiler::AssignIdsLocked(ProfileNode* node, uint32_t* next_id) {
  node->id = (*next_id)++;
  for (auto& child : node->children)
    AssignIdsLocked(child.get(), next_id);
}

std::string Profiler::SerializeJson() {
  std::lock_guard<std::mutex> lock(mutex_);

  // Stable ids first: samples and spans below refer to nodes by id.
  uint32_t next_id = 0;
  AssignIdsLocked(&root_, &next_id);

  std::string out;
  out.reserve(65536);
  // The root is a synthetic container; expose its children as the top level.
  out += "{\"tree\":{\"name\":\"<root>\",\"group\":\"\",\"id\":0,\"totalMs\":0,\"selfMs\":0,"
         "\"calls\":0,\"minSelfMs\":0,\"maxSelfMs\":0,\"p95SelfMs\":0,\"children\":[";
  for (size_t i = 0; i < root_.children.size(); i++) {
    if (i) out += ",";
    SerializeNode(root_.children[i].get(), out);
  }
  out += "]}";

  // Timeline. Parallel arrays keep this compact: sample i means "node ids[i] ran
  // for dt[i] nanoseconds, starting at start[i]". These are measured, not
  // synthesised -- the client can build a truthful .cpuprofile from them.
  char buf[128];
  out += ",\"samples\":{\"truncated\":";
  out += samples_truncated_ ? "true" : "false";
  out += ",\"id\":[";
  for (size_t i = 0; i < samples_.size(); i++) {
    if (i) out += ",";
    snprintf(buf, sizeof(buf), "%u", samples_[i].node->id);
    out += buf;
  }
  out += "],\"dtUs\":[";
  for (size_t i = 0; i < samples_.size(); i++) {
    if (i) out += ",";
    snprintf(buf, sizeof(buf), "%.3f", samples_[i].dt_ns / 1000.0);
    out += buf;
  }
  out += "],\"startUs\":[";
  for (size_t i = 0; i < samples_.size(); i++) {
    if (i) out += ",";
    snprintf(buf, sizeof(buf), "%.3f", samples_[i].start_ns / 1000.0);
    out += buf;
  }
  out += "]}";

  // Spans: one per completed call, for the trace/timeline export.
  out += ",\"spans\":{\"truncated\":";
  out += spans_truncated_ ? "true" : "false";
  out += ",\"items\":[";
  for (size_t i = 0; i < spans_.size(); i++) {
    if (i) out += ",";
    const ProfileSpan& span = spans_[i];
    const uint64_t dur_ns = span.end_ns > span.start_ns ? span.end_ns - span.start_ns : 0;
    snprintf(buf, sizeof(buf), "{\"id\":%u,\"tsUs\":%.3f,\"durUs\":%.3f,\"depth\":%u}",
             span.node->id, span.start_ns / 1000.0, dur_ns / 1000.0, span.depth);
    out += buf;
  }
  out += "]}}";
  return out;
}
