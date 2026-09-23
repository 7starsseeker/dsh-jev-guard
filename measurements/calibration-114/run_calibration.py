#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
三臂校准测试：中文直连 vs 机器翻译 vs 翻译+回译校验
  A = 中文 state + 中文 questions -> Jev
  B = deepseek-flash 一次过翻译成英文 -> Jev
  C = 翻译 + 回译校验（不一致则带反馈重译一次）-> Jev

指标：准确率 / 可靠性曲线（confidence 分桶 vs 实际正确率）/ Brier / MAE
      Jev 延迟 P50 P95 / 翻译开销 / token 与费用
密钥只从环境变量取，永不打印。
"""
import json, os, re, statistics, sys, time, threading
import urllib.request, urllib.error
from concurrent.futures import ThreadPoolExecutor

ROOT = os.path.dirname(os.path.abspath(__file__))
JEV_URL = "https://api.typesafe.ai/v1/systemone"
DS_URL = "https://api.deepseek.com/chat/completions"
JEV_KEY = os.environ.get("TYPESAFE_API_KEY")
DS_KEY = os.environ.get("DEEPSEEK_API_KEY")
JEV_COST_PER_TOKEN = 4.2e-8  # $0.042 / Mtok 输入，输出免费

BUCKETS = [0.5, 0.6, 0.7, 0.8, 0.9, 1.0001]


def http_post(url, payload, key, timeout=120, retries=3):
    data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    last = None
    for attempt in range(retries):
        t0 = time.time()
        req = urllib.request.Request(url, data=data, headers={
            "Authorization": "Bearer " + key,
            "Content-Type": "application/json",
        })
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return json.loads(r.read().decode("utf-8")), time.time() - t0, None
        except urllib.error.HTTPError as e:
            body = e.read().decode("utf-8", "replace")[:300]
            dt = time.time() - t0
            last = "HTTP %s: %s" % (e.code, body)
            if e.code in (429, 500, 502, 503):
                time.sleep(1.5 * (attempt + 1))
                continue
            return None, dt, last
        except Exception as e:
            last = "%s: %s" % (type(e).__name__, e)
            time.sleep(1.0 * (attempt + 1))
    return None, 0.0, last


def extract_json(text):
    text = re.sub(r"^```(?:json)?|```$", "", text.strip(), flags=re.M).strip()
    i, j = text.find("{"), text.rfind("}")
    if i < 0 or j < 0:
        raise ValueError("no JSON in output: " + text[:200])
    return json.loads(text[i:j + 1])


TR_SYS = (
    "You are a precise technical translator for an evaluation harness. "
    "Translate the Chinese JSON given by the user into English. "
    "Preserve the JSON structure and every key EXACTLY as-is; translate only the string values. "
    "Keep all facts, numbers, negations, severity words and criteria exactly equivalent. "
    "Do not add, drop or explain anything. Output ONLY the JSON object, no markdown fence, no commentary."
)
BT_SYS = (
    "You are a precise technical translator. Translate the English JSON given by the user back into Chinese. "
    "Preserve the JSON structure and every key EXACTLY; translate only the string values. "
    "Output ONLY the JSON object, no markdown fence, no commentary."
)
JUDGE_SYS = (
    "You compare two Chinese JSON objects: the ORIGINAL and a round-trip version (original -> English -> Chinese). "
    "Decide whether every key fact, number, negation and decision criterion is preserved. "
    "Reply with exactly 'OK' if preserved. Otherwise reply 'MISMATCH: <short description of what differs>'. "
    "No other output."
)

TR_TEXT_SYS = (
    "Translate the Chinese text given by the user into English. "
    "Keep all facts, numbers, negations, severity words and tone exactly equivalent. "
    "Output ONLY the English translation, with no quotes, no JSON, no commentary."
)
BT_TEXT_SYS = (
    "Translate the English text given by the user back into Chinese. "
    "Output ONLY the Chinese translation, with no quotes, no commentary."
)
JUDGE_TEXT_SYS = (
    "You compare two Chinese texts: the ORIGINAL and a round-trip version (original -> English -> Chinese). "
    "Decide whether every key fact, number, negation, severity and nuance is preserved. "
    "Reply with exactly 'OK' if preserved. Otherwise reply 'MISMATCH: <short description of what differs>'. "
    "No other output."
)


def ds_call(system, user, temp=0.0):
    body, dt, err = http_post(DS_URL, {
        "model": "deepseek-flash",
        "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}],
        "temperature": temp,
        "stream": False,
    }, DS_KEY)
    if err:
        return None, dt, err, 0
    try:
        txt = body["choices"][0]["message"]["content"]
    except Exception as e:
        return None, dt, "bad response: %s" % e, 0
    tok = (body.get("usage") or {}).get("total_tokens", 0)
    return txt, dt, None, tok


class Translator:
    """翻译 + 可选回译校验；按 key 缓存，并累计开销。"""

    def __init__(self):
        self.cache, self.lock = {}, threading.Lock()
        self.calls, self.tokens, self.seconds = 0, 0, 0.0
        self.verified, self.retried, self.unverified = 0, 0, 0

    def _cached(self, key, fn):
        with self.lock:
            if key in self.cache:
                return self.cache[key]
        val = fn()
        with self.lock:
            self.cache[key] = val
        return val

    def translate(self, obj, key, verify, feedback=None):
        def work():
            # state 可能是纯字符串，也可能是 JSON 对象 —— 两条路径分开处理
            is_text = isinstance(obj, str)
            payload = obj if is_text else json.dumps(obj, ensure_ascii=False)
            tr_sys = TR_TEXT_SYS if is_text else TR_SYS
            bt_sys = BT_TEXT_SYS if is_text else BT_SYS
            judge_sys = JUDGE_TEXT_SYS if is_text else JUDGE_SYS

            def send(system, user):
                txt, dt, err, tok = ds_call(system, user)
                with self.lock:
                    self.calls += 1; self.tokens += tok; self.seconds += dt
                return txt, err

            def decode(txt):
                if is_text:
                    s = (txt or "").strip()
                    if s.startswith('"') and s.endswith('"'):
                        s = s[1:-1]
                    if not s:
                        raise ValueError("empty translation")
                    return s
                return extract_json(txt)

            def ser(v):
                return v if is_text else json.dumps(v, ensure_ascii=False)

            user = payload
            if feedback:
                user = payload + "\n\nPrevious attempt was reported as: " + feedback + "\nFix that and retranslate."

            txt, err = send(tr_sys, user)
            if err:
                return {"en": None, "error": err}
            try:
                en = decode(txt)
            except Exception as e1:
                force = "\n\nOutput ONLY the JSON object." if not is_text else ""
                txt2, err2 = send(tr_sys, user + force)
                if err2:
                    return {"en": None, "error": "parse: %s" % e1}
                try:
                    en = decode(txt2)
                except Exception as e2:
                    return {"en": None, "error": "parse: %s" % e2}

            if not verify:
                return {"en": en, "verified": None, "attempts": 1}

            bt, err2 = send(bt_sys, ser(en))
            if err2 or bt is None:
                with self.lock: self.unverified += 1
                return {"en": en, "verified": False, "attempts": 1, "note": "backtranslate failed"}
            try:
                zh2 = decode(bt)
            except Exception:
                with self.lock: self.unverified += 1
                return {"en": en, "verified": False, "attempts": 1, "note": "backtranslate unparsable"}

            v, err3 = send(judge_sys, "ORIGINAL:\n%s\n\nROUND-TRIP:\n%s" % (payload, ser(zh2)))
            verdict = (v or "").strip()
            if verdict.startswith("OK"):
                with self.lock: self.verified += 1
                return {"en": en, "verified": True, "attempts": 1}

            # 不一致 -> 带反馈重译一次
            with self.lock: self.retried += 1
            txt2, err4 = send(tr_sys, payload + "\n\nPrevious attempt was reported as: " + verdict[:300] + "\nFix that and retranslate.")
            if err4:
                with self.lock: self.unverified += 1
                return {"en": en, "verified": False, "attempts": 2, "note": verdict[:200]}
            try:
                en2 = decode(txt2)
            except Exception:
                en2 = en
            with self.lock: self.unverified += 1  # 重译后未再验证
            return {"en": en2, "verified": False, "attempts": 2, "note": verdict[:200]}

        return self._cached(key, work)


def jev_call(state, questions):
    body, dt, err = http_post(JEV_URL, {
        "model": "jev-latest", "state": state, "questions": questions,
    }, JEV_KEY)
    if err:
        return None, dt, err
    return body, dt, None


def parse_label(label):
    return label


def grade(answer, label, qdef):
    """return (correct, confidence, err_abs)"""
    t = answer.get("type")
    if t == "noul":
        p = float(answer.get("noul", 0.5))
        pred = p >= 0.5
        return (pred == bool(label)), abs(p - 0.5) * 2, None
    if t == "choice":
        pred = answer.get("choice")
        conf = answer.get("confidence")
        if conf is None and isinstance(answer.get("probabilities"), dict):
            conf = max(answer["probabilities"].values())
        return (pred == label), float(conf if conf is not None else 0.5), None
    if t == "score":
        s = float(answer.get("score", 0))
        n = len(qdef.get("criteria", []) or [0, 1, 2])
        pred = int(round(max(0.0, min(s, n - 1))))
        conf = answer.get("confidence")
        if conf is None and isinstance(answer.get("probabilities"), dict):
            conf = max(answer["probabilities"].values())
        return (pred == int(label)), float(conf if conf is not None else 0.5), abs(s - float(label))
    return None, None, None


def main():
    cfgs = json.load(open(os.path.join(ROOT, "cases.zh.json"), encoding="utf-8"))
    schemas, cases = cfgs["schemas"], cfgs["cases"]

    if not JEV_KEY or not DS_KEY:
        print("!! 缺少 TYPESAFE_API_KEY 或 DEEPSEEK_API_KEY 环境变量"); sys.exit(2)

    print("[preflight] TypeSafe /v1/models ...", flush=True)
    req = urllib.request.Request("https://api.typesafe.ai/v1/models",
                                 headers={"Authorization": "Bearer " + JEV_KEY})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            print("  ok:", r.read().decode()[:160], flush=True)
    except Exception as e:
        print("  FAIL:", e); sys.exit(2)
    txt, dt, err, tok = ds_call("Reply with exactly: ready", "ready")
    print("[preflight] DeepSeek translator ...", "ok" if not err else "FAIL " + str(err), flush=True)
    if err:
        sys.exit(2)

    trB, trC = Translator(), Translator()
    schema_en = {}

    # 先把四个 domain 的 questions 串行翻译好（避免并发线程重复翻译同一份 schema，
    # 那会把「翻译开销」统计成上界而不是实际值）
    for arm, tr, verify in (("B", trB, False), ("C", trC, True)):
        for dom, qs in schemas.items():
            sk = "%s|%s" % (arm, dom)
            print("[schema] %s 翻译中 ..." % sk, flush=True)
            schema_en[sk] = tr.translate(qs, sk, verify)

    def build_arm(case, arm):
        domain = case["domain"]
        zh_qs = {qid: schemas[domain][qid] for qid in case["questions"]}
        if arm == "A":
            return case["state"], zh_qs, 0.0, "", None
        tr = trB if arm == "B" else trC
        verify = (arm == "C")
        qres = schema_en["%s|%s" % (arm, domain)]
        sres = tr.translate(case["state"], "%s|%s" % (arm, case["id"]), verify)
        en_state = sres.get("en")
        en_qs = qres.get("en")
        if en_state is None or en_qs is None:
            raise RuntimeError("translation failed: %s / %s" % (sres.get("error"), qres.get("error")))
        note = ""
        if verify:
            flags = []
            if sres.get("verified") is False: flags.append("state:%s" % (sres.get("note") or "retry"))
            if qres.get("verified") is False: flags.append("schema:%s" % (qres.get("note") or "retry"))
            note = "; ".join(flags)
        return en_state, en_qs, 0.0, note, {"state_en": en_state, "questions_en": en_qs}

    records, lock = [], threading.Lock()

    def work(case):
        out = {}
        for arm in ("A", "B", "C"):
            try:
                state, qs, _, note, extra = build_arm(case, arm)
            except Exception as e:
                out[arm] = {"arm": arm, "case": case["id"], "domain": case["domain"],
                            "error": "build: %s" % e, "latency": 0.0}
                continue
            body, dt, err = jev_call(state, qs)
            rec = {"arm": arm, "case": case["id"], "domain": case["domain"],
                   "latency": dt, "error": err, "note": note}
            if extra:
                rec.update(extra)
            if not err and body:
                rec["answers"] = body.get("answers", {})
                rec["usage"] = body.get("usage", {})
                rec["model"] = body.get("model")
            out[arm] = rec
        with lock:
            records.extend(out[a] for a in ("A", "B", "C"))
            print("  done %-4s (%d/%d)" % (case["id"], len(records) // 3, len(cases)), flush=True)

    t_start = time.time()
    with ThreadPoolExecutor(max_workers=5) as ex:
        list(ex.map(work, cases))
    wall = time.time() - t_start
    print("[run] wall %.1fs" % wall, flush=True)

    by_key = {(r["case"], r["arm"]): r for r in records}
    case_by_id = {c["id"]: c for c in cases}

    # ---------- 打分 ----------
    scored = []
    for r in records:
        case = case_by_id[r["case"]]
        if r.get("error") or not r.get("answers"):
            continue
        for qid in case["questions"]:
            ans = (r["answers"] or {}).get(qid)
            if not ans:
                continue
            qdef = schemas[case["domain"]][qid]
            ok, conf, err_abs = grade(ans, case["labels"][qid], qdef)
            scored.append({"arm": r["arm"], "case": r["case"], "domain": r["domain"], "qid": qid,
                           "type": ans.get("type"), "correct": bool(ok), "confidence": conf,
                           "err_abs": err_abs, "answer": ans, "latency": r["latency"],
                           "label": case["labels"][qid]})

    def acc(rows):
        return (sum(1 for x in rows if x["correct"]) / len(rows) * 100) if rows else float("nan")

    report = []
    W = report.append
    W("# Jev 三臂校准测试报告\n")
    W("样本 %d 个 case / %d 个判断问题；三条臂各跑一遍，耗时 %.0fs。\n" % (len(cases), len({x["case"] + x["qid"] for x in scored}), wall))
    W("- **A** 中文直连  \n- **B** 机器翻译（deepseek-flash 一次过）→ Jev  \n- **C** 翻译 + 回译校验（不一致则带反馈重译一次）→ Jev\n")

    err_by_arm = {a: sum(1 for r in records if r["arm"] == a and r.get("error")) for a in "ABC"}
    if any(err_by_arm.values()):
        W("> ⚠️ **调用失败：A=%d / B=%d / C=%d** —— 各臂分母不同，直接横向对比无效，请看 1b 的配对对比。\n"
          % (err_by_arm["A"], err_by_arm["B"], err_by_arm["C"]))

    W("## 1. 总准确率\n")
    W("| 臂 | 样本数 | 正确 | 准确率 |\n|---|---|---|---|")
    for arm in "ABC":
        rows = [x for x in scored if x["arm"] == arm]
        W("| %s | %d | %d | **%.1f%%** |" % (arm, len(rows), sum(1 for x in rows if x["correct"]), acc(rows)))

    # 配对对比：只保留三臂都成功的 case，消除分母差异
    all_ids = {c["id"] for c in cases}
    common = set(all_ids)
    for arm in "ABC":
        ok = {r["case"] for r in records if r["arm"] == arm and not r.get("error") and r.get("answers")}
        common &= ok
    if common != all_ids:
        W("\n## 1b. 配对对比（仅三臂都成功的 %d/%d 个 case）\n" % (len(common), len(all_ids)))
        W("| 臂 | 样本数 | 正确 | 准确率 |\n|---|---|---|---|")
        for arm in "ABC":
            rows = [x for x in scored if x["arm"] == arm and x["case"] in common]
            W("| %s | %d | %d | **%.1f%%** |" % (arm, len(rows), sum(1 for x in rows if x["correct"]), acc(rows)))

    W("\n## 2. 按问题类型\n")
    W("| 臂 | noul（是/否） | choice（选择） | score（分档） |\n|---|---|---|---|")
    for arm in "ABC":
        cells = []
        for t in ("noul", "choice", "score"):
            rows = [x for x in scored if x["arm"] == arm and x["type"] == t]
            cells.append("%.1f%% (%d/%d)" % (acc(rows), sum(1 for x in rows if x["correct"]), len(rows)) if rows else "-")
        W("| %s | %s | %s | %s |" % (arm, *cells))

    W("\n## 3. 按场景\n")
    doms = ["support", "ops", "coding", "triage"]
    W("| 臂 | " + " | ".join(doms) + " |\n|---|" + "---|" * len(doms))
    for arm in "ABC":
        cells = []
        for d in doms:
            rows = [x for x in scored if x["arm"] == arm and x["domain"] == d]
            cells.append("%.0f%% (n=%d)" % (acc(rows), len(rows)) if rows else "-")
        W("| %s | %s |" % (arm, " | ".join(cells)))

    W("\n## 4. 可靠性（置信度分桶 vs 实际正确率）\n")
    W("置信度越高、正确率越高才是**校准**的。noul 用 |p-0.5|×2 作置信度代理。\n")
    W("| 置信度区间 | A | B | C |\n|---|---|---|---|")
    for lo, hi in zip(BUCKETS[:-1], BUCKETS[1:]):
        cells = []
        for arm in "ABC":
            rows = [x for x in scored if x["arm"] == arm and x["confidence"] is not None
                    and lo <= x["confidence"] < hi]
            cells.append("%.0f%% (n=%d)" % (acc(rows), len(rows)) if rows else "-")
        W("| %.1f–%.1f | %s | %s | %s |" % (lo, hi, *cells))

    W("\n## 5. 概率质量指标\n")
    W("| 臂 | noul Brier（越低越好） | score MAE（越低越好） | 平均置信度 |\n|---|---|---|---|")
    for arm in "ABC":
        noul = [x for x in scored if x["arm"] == arm and x["type"] == "noul"]
        sc = [x for x in scored if x["arm"] == arm and x["type"] == "score"]
        brier = float("nan")
        if noul:
            brier = statistics.mean((float(x["answer"]["noul"]) - (1.0 if x["label"] else 0.0)) ** 2 for x in noul)
        mae = statistics.mean([x["err_abs"] for x in sc if x["err_abs"] is not None]) if sc else float("nan")
        confs = [x["confidence"] for x in scored if x["arm"] == arm and x["confidence"] is not None]
        W("| %s | %.4f | %.3f | %.3f |" % (arm, brier, mae, statistics.mean(confs) if confs else float("nan")))

    W("\n## 6. 延迟与开销\n")
    W("| 臂 | Jev 调用数 | 平均 | P50 | P95 | 翻译调用 | 翻译耗时合计 | 翻译 token | Jev input token | Jev 费用 |\n|---|---|---|---|---|---|---|---|---|---|")
    for arm in "ABC":
        lats = sorted(x["latency"] for x in scored if x["arm"] == arm and x["latency"])
        recs = [by_key[(c["id"], arm)] for c in cases if (c["id"], arm) in by_key and not by_key[(c["id"], arm)].get("error")]
        tok = sum((r.get("usage") or {}).get("input_tokens", 0) for r in recs)
        tr = trB if arm == "B" else (trC if arm == "C" else None)
        W("| %s | %d | %.2fs | %.2fs | %.2fs | %d | %.1fs | %d | %d | $%.6f |" % (
            arm, len(lats),
            statistics.mean(lats) if lats else 0,
            lats[len(lats) // 2] if lats else 0,
            lats[min(len(lats) - 1, int(len(lats) * 0.95))] if lats else 0,
            tr.calls if tr else 0, tr.seconds if tr else 0.0, tr.tokens if tr else 0,
            tok, tok * JEV_COST_PER_TOKEN))

    if trC.calls:
        W("\n臂 C 的翻译校验：%d 次调用里，%d 个对象首次回译即通过，%d 个触发带反馈重译，%d 个最终未通过校验。\n"
          % (trC.calls, trC.verified, trC.retried, trC.unverified))

    W("\n## 7. 三臂判断分歧明细\n")
    W("| case | 问题 | 正确标签 | A | B | C |\n|---|---|---|---|---|---|")
    idx = {}
    for x in scored:
        idx.setdefault((x["case"], x["qid"]), {})[x["arm"]] = x
    disagree = 0
    for (cid, qid), arms in sorted(idx.items()):
        okset = {a: arms[a]["correct"] for a in "ABC" if a in arms}
        if len(set(okset.values())) > 1:
            disagree += 1
            def fmt(a):
                x = arms.get(a)
                if not x: return "-"
                ans = x["answer"]
                v = ans.get("noul", ans.get("choice", ans.get("score")))
                if isinstance(v, float): v = "%.2f" % v
                return "%s%s" % ("✓" if x["correct"] else "✗", v)
            W("| %s | %s | %s | %s | %s | %s |" % (cid, qid, case_by_id[cid]["labels"][qid], fmt("A"), fmt("B"), fmt("C")))
    if not disagree:
        W("| （无分歧） | | | | | |")

    errs = [r for r in records if r.get("error")]
    if errs:
        W("\n## 8. 调用失败\n")
        for r in errs[:20]:
            W("- %s/%s: %s" % (r["case"], r["arm"], r["error"]))

    open(os.path.join(ROOT, "report.md"), "w", encoding="utf-8").write("\n".join(report) + "\n")
    json.dump({"wall": wall, "records": records, "scored": scored}, open(os.path.join(ROOT, "results.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    print("[done] report.md + results.json 已写出", flush=True)
    print("\n".join(report[:40]), flush=True)


if __name__ == "__main__":
    main()
