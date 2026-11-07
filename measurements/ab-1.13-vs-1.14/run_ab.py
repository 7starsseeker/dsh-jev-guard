#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
A/B: jev-1.13.0 vs jev-1.14.0 on the 114-question calibration set.

Uses exactly the same request shape as arm A of calibration-114
(Chinese state + Chinese questions, direct), and the same grade() rule,
so numbers are directly comparable to report.md (A = 90.4%).

Outputs: report.md, results.json
Never prints the API key.
"""
import json, os, statistics, sys, time, threading
import urllib.request, urllib.error
from concurrent.futures import ThreadPoolExecutor

ROOT = os.path.dirname(os.path.abspath(__file__))
CASES = os.path.normpath(os.path.join(ROOT, "..", "calibration-114", "cases.zh.json"))
SECRETS = r"T:\jev-guard\secrets.json"
URL = "https://api.typesafe.ai/v1/systemone"
COST_PER_TOKEN = 4.2e-8          # $0.042 / Mtok input, output free
MODELS = ["jev-1.13.0", "jev-1.14.0"]
# AB_SUFFIX=_after writes report_after.md / results_after.json instead of overwriting
# the recorded run, so a criteria change can be compared against the original.
SUFFIX = os.environ.get("AB_SUFFIX", "")


def load_key():
    k = os.environ.get("TYPESAFE_API_KEY") or ""
    if not k and os.path.exists(SECRETS):
        k = json.load(open(SECRETS, encoding="utf-8")).get("TYPESAFE_API_KEY", "")
    if not k:
        print("!! no TYPESAFE_API_KEY"); sys.exit(2)
    return k


KEY = load_key()


def post(payload, timeout=120, retries=4):
    data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    last = None
    for attempt in range(retries):
        t0 = time.time()
        req = urllib.request.Request(URL, data=data, headers={
            "Authorization": "Bearer " + KEY,
            "Content-Type": "application/json",
        })
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return json.loads(r.read().decode("utf-8")), time.time() - t0, None
        except urllib.error.HTTPError as e:
            body = e.read().decode("utf-8", "replace")[:300]
            last = "HTTP %s: %s" % (e.code, body)
            if e.code in (429, 500, 502, 503, 529):
                time.sleep(1.5 * (attempt + 1)); continue
            return None, time.time() - t0, last
        except Exception as e:
            last = "%s: %s" % (type(e).__name__, e)
            time.sleep(1.0 * (attempt + 1))
    return None, 0.0, last


def grade(answer, label, qdef):
    """Same rule as calibration-114/run_calibration.py"""
    t = answer.get("type")
    if t == "noul":
        p = float(answer.get("noul", 0.5))
        return (p >= 0.5) == bool(label), abs(p - 0.5) * 2, None, p
    if t == "choice":
        pred = answer.get("choice")
        conf = answer.get("confidence")
        probs = answer.get("probabilities") or {}
        pmax = max(probs.values()) if probs else None
        if conf is None and pmax is not None:
            conf = pmax
        return (pred == label), float(conf if conf is not None else 0.5), None, pmax
    if t == "score":
        s = float(answer.get("score", 0))
        n = len(qdef.get("criteria", []) or [0, 1, 2])
        pred = int(round(max(0.0, min(s, n - 1))))
        conf = answer.get("confidence")
        probs = answer.get("probabilities") or {}
        pmax = max(probs.values()) if probs else None
        if conf is None and pmax is not None:
            conf = pmax
        return (pred == int(label)), float(conf if conf is not None else 0.5), abs(s - float(label)), pmax
    return None, None, None, None


def main():
    cfg = json.load(open(CASES, encoding="utf-8"))
    schemas, cases = cfg["schemas"], cfg["cases"]
    n_q = sum(len(c["questions"]) for c in cases)
    print("[setup] %d cases / %d questions / models=%s" % (len(cases), n_q, MODELS), flush=True)

    records, lock = [], threading.Lock()
    done = [0]

    def work(case):
        qs = {qid: schemas[case["domain"]][qid] for qid in case["questions"]}
        for m in MODELS:
            body, dt, err = post({"model": m, "state": case["state"], "questions": qs})
            rec = {"model": m, "case": case["id"], "domain": case["domain"],
                   "latency": dt, "error": err}
            if not err and body:
                rec["answers"] = body.get("answers", {})
                rec["usage"] = body.get("usage", {})
                rec["served_model"] = body.get("model")
            with lock:
                records.append(rec)
        with lock:
            done[0] += 1
            if done[0] % 10 == 0:
                print("  %d/%d cases" % (done[0], len(cases)), flush=True)

    t0 = time.time()
    with ThreadPoolExecutor(max_workers=5) as ex:
        list(ex.map(work, cases))
    wall = time.time() - t0
    print("[run] wall %.1fs, calls=%d" % (wall, len(records)), flush=True)

    case_by_id = {c["id"]: c for c in cases}
    scored = []
    for r in records:
        if r.get("error") or not r.get("answers"):
            continue
        case = case_by_id[r["case"]]
        for qid in case["questions"]:
            ans = r["answers"].get(qid)
            if not ans:
                continue
            ok, conf, err_abs, pmax = grade(ans, case["labels"][qid], schemas[case["domain"]][qid])
            scored.append({"model": r["model"], "case": r["case"], "qid": qid, "domain": r["domain"],
                           "type": ans.get("type"), "correct": bool(ok), "confidence": conf,
                           "err_abs": err_abs, "pmax": pmax, "answer": ans,
                           "label": case["labels"][qid], "latency": r["latency"]})

    def acc(rows):
        return (100.0 * sum(1 for x in rows if x["correct"]) / len(rows)) if rows else float("nan")

    R = []
    W = R.append
    served = {m: set(r.get("served_model") for r in records if r["model"] == m and not r.get("error")) for m in MODELS}
    errs = {m: sum(1 for r in records if r["model"] == m and r.get("error")) for m in MODELS}

    W("# jev-1.13.0 vs jev-1.14.0 · 114 题 A/B\n")
    W("请求形状与 calibration-114 的 A 臂完全一致（中文 state + 中文 questions，直连）。")
    W("打分口径复用 `run_calibration.py::grade()`。\n")
    W("- 调用失败：%s" % ", ".join("%s=%d" % (m, errs[m]) for m in MODELS))
    W("- 服务端实际应答 model：%s" % ", ".join("%s→%s" % (m, sorted(served[m])) for m in MODELS))
    W("- wall %.1fs\n" % wall)

    W("## 1. 总准确率\n")
    W("| 模型 | 正确 | 准确率 | 与 1.13 的配对差 |")
    W("|---|---|---|---|")
    base = None
    for m in MODELS:
        rows = [x for x in scored if x["model"] == m]
        a = acc(rows)
        if base is None:
            base = a
            delta = "—"
        else:
            delta = "%+.1f pp" % (a - base)
        W("| %s | %d/%d | **%.1f%%** | %s |" % (m, sum(1 for x in rows if x["correct"]), len(rows), a, delta))

    W("\n## 2. 按问题类型\n")
    W("| 模型 | noul | choice | score |")
    W("|---|---|---|---|")
    for m in MODELS:
        cells = []
        for t in ("noul", "choice", "score"):
            rows = [x for x in scored if x["model"] == m and x["type"] == t]
            cells.append("%.1f%% (%d/%d)" % (acc(rows), sum(1 for x in rows if x["correct"]), len(rows)) if rows else "-")
        W("| %s | %s |" % (m, " | ".join(cells)))

    W("\n## 3. 按场景\n")
    doms = ["support", "ops", "coding", "triage"]
    W("| 模型 | " + " | ".join(doms) + " |")
    W("|---|" + "---|" * len(doms))
    for m in MODELS:
        cells = []
        for d in doms:
            rows = [x for x in scored if x["model"] == m and x["domain"] == d]
            cells.append("%.0f%% (n=%d)" % (acc(rows), len(rows)) if rows else "-")
        W("| %s | %s |" % (m, " | ".join(cells)))

    W("\n## 4. 概率质量\n")
    W("| 模型 | noul Brier | score MAE | 平均 confidence | 平均 pmax |")
    W("|---|---|---|---|---|")
    for m in MODELS:
        noul = [x for x in scored if x["model"] == m and x["type"] == "noul"]
        sc = [x for x in scored if x["model"] == m and x["type"] == "score"]
        brier = statistics.mean((float(x["answer"]["noul"]) - (1.0 if x["label"] else 0.0)) ** 2 for x in noul) if noul else float("nan")
        mae = statistics.mean([x["err_abs"] for x in sc if x["err_abs"] is not None]) if sc else float("nan")
        confs = [x["confidence"] for x in scored if x["model"] == m and x["confidence"] is not None]
        pmaxs = [x["pmax"] for x in scored if x["model"] == m and x["pmax"] is not None]
        W("| %s | %.4f | %.3f | %.3f | %.3f |" % (m, brier, mae,
          statistics.mean(confs) if confs else float("nan"),
          statistics.mean(pmaxs) if pmaxs else float("nan")))

    # ---------- 5. noul 阈值扫描 ----------
    W("\n## 5. noul 决策阈值扫描（p≥τ 判 true，p≤1−τ 判 false，中间弃权）\n")
    W("| τ | " + " | ".join("%s 覆盖/准确" % m for m in MODELS) + " |")
    W("|---|" + "---|" * len(MODELS))
    for tau in [0.50, 0.55, 0.60, 0.65, 0.70, 0.75, 0.80, 0.85, 0.90, 0.95]:
        cells = []
        for m in MODELS:
            rows = [x for x in scored if x["model"] == m and x["type"] == "noul"]
            dec = []
            for x in rows:
                p = float(x["answer"]["noul"])
                if p >= tau: dec.append((True, bool(x["label"])))
                elif p <= 1 - tau: dec.append((False, bool(x["label"])))
            if not dec:
                cells.append("0% / -"); continue
            cov = 100.0 * len(dec) / len(rows)
            a = 100.0 * sum(1 for pred, lab in dec if pred == lab) / len(dec)
            cells.append("%.0f%% / %.1f%%" % (cov, a))
        W("| %.2f | %s |" % (tau, " | ".join(cells)))

    # ---------- 6. choice/score 阈值扫描 ----------
    W("\n## 6. choice / score 置信度门控扫描（conf < t 转人工）\n")
    W("| t | " + " | ".join("%s 转人工/自动段准确" % m for m in MODELS) + " |")
    W("|---|" + "---|" * len(MODELS))
    for t in [0.30, 0.40, 0.50, 0.55, 0.60, 0.65, 0.70, 0.75, 0.80, 0.85, 0.90]:
        cells = []
        for m in MODELS:
            rows = [x for x in scored if x["model"] == m and x["type"] in ("choice", "score")]
            auto = [x for x in rows if x["confidence"] is not None and x["confidence"] >= t]
            if not auto:
                cells.append("100% / -"); continue
            esc = 100.0 * (len(rows) - len(auto)) / len(rows)
            cells.append("%.0f%% / %.1f%%" % (esc, acc(auto)))
        W("| %.2f | %s |" % (t, " | ".join(cells)))

    # ---------- 7. 两版逐题差异 ----------
    idx = {}
    for x in scored:
        idx.setdefault((x["case"], x["qid"]), {})[x["model"]] = x
    diffs = []
    for (cid, qid), d in sorted(idx.items()):
        a, b = d.get(MODELS[0]), d.get(MODELS[1])
        if not a or not b:
            continue
        va = a["answer"].get("noul", a["answer"].get("choice", a["answer"].get("score")))
        vb = b["answer"].get("noul", b["answer"].get("choice", b["answer"].get("score")))
        if a["correct"] != b["correct"] or (isinstance(va, float) and isinstance(vb, float) and abs(va - vb) >= 0.10):
            diffs.append((cid, qid, a["type"], a["label"], va, a["correct"], vb, b["correct"]))
    W("\n## 7. 判定翻转或数值差 ≥0.10 的题（共 %d 条）\n" % len(diffs))
    W("| case | 问题 | 类型 | 标签 | 1.13 | 1.13 对错 | 1.14 | 1.14 对错 |")
    W("|---|---|---|---|---|---|---|---|")
    for cid, qid, typ, lab, va, oka, vb, okb in diffs:
        f = lambda v: ("%.2f" % v) if isinstance(v, float) else str(v)
        W("| %s | %s | %s | %s | %s | %s | %s | %s |" % (cid, qid, typ, lab, f(va), "✓" if oka else "✗", f(vb), "✓" if okb else "✗"))

    # ---------- 8. 延迟与成本 ----------
    W("\n## 8. 延迟与成本\n")
    W("| 模型 | 调用 | 平均 | P50 | P95 | input token | 费用 |")
    W("|---|---|---|---|---|---|---|")
    for m in MODELS:
        recs = [r for r in records if r["model"] == m and not r.get("error")]
        lats = sorted(r["latency"] for r in recs)
        tok = sum((r.get("usage") or {}).get("input_tokens", 0) for r in recs)
        W("| %s | %d | %.2fs | %.2fs | %.2fs | %d | $%.6f |" % (
            m, len(lats),
            statistics.mean(lats) if lats else 0,
            lats[len(lats) // 2] if lats else 0,
            lats[min(len(lats) - 1, int(len(lats) * 0.95))] if lats else 0,
            tok, tok * COST_PER_TOKEN))

    rp = os.path.join(ROOT, "report%s.md" % SUFFIX)
    jp = os.path.join(ROOT, "results%s.json" % SUFFIX)
    open(rp, "w", encoding="utf-8").write("\n".join(R) + "\n")
    json.dump({"wall": wall, "models": MODELS, "records": records, "scored": scored},
              open(jp, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    print("\n".join(R), flush=True)
    print("[done] %s + %s" % (os.path.basename(rp), os.path.basename(jp)), flush=True)


if __name__ == "__main__":
    main()
