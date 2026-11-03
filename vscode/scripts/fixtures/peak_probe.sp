/**
 * peak_probe.sp -- fixture for scripts/test-perf.mjs (SP_PEAKS=1).
 *
 * `peak_probe [n]` uses a KNOWN amount of memory so the panel's peak stack/heap
 * can be checked against it:
 *   - a 512-cell (2048 byte) local array
 *   - a dynamic array of n cells (4 * n bytes), alive at the same time
 * SourcePawn allocates BOTH on the plugin's heap (local arrays are freed on
 * return); the stack only holds call frames and scalars.
 *
 * The line below is replaced by `#pragma dynamic 131072` to build the "with
 * pragma" variant. The code, and so the peak, is identical either way; only the
 * reserved Stack/heap size changes.
 */
//@PRAGMA@

#include <sourcemod>

#pragma semicolon 1
#pragma newdecls required

public Plugin myinfo =
{
	name = "peak_probe",
	author = "sp-debugger tests",
	description = "Uses a known amount of stack and heap",
	version = "1.0",
	url = ""
};

public void OnPluginStart()
{
	RegServerCmd("peak_probe", Command_Probe);
}

int UseBoth(int n)
{
	int stk[512];
	int[] dyn = new int[n];
	for (int i = 0; i < 512; i++) {
		stk[i] = i;
	}
	for (int i = 0; i < n; i++) {
		dyn[i] = i;
	}
	int result = stk[n % 512] + dyn[n - 1];
	return result;
}

public Action Command_Probe(int args)
{
	int n = 1000;
	if (args >= 1) {
		char arg[16];
		GetCmdArg(1, arg, sizeof(arg));
		n = StringToInt(arg);
		if (n < 1) {
			n = 1;
		}
		if (n > 8000) {
			n = 8000;
		}
	}
	PrintToServer("peak_probe: %d", UseBoth(n));
	return Plugin_Handled;
}
