# -*- coding: utf-8 -*-
"""从《调试编年史.html》重新生成 assets/chronicle.json。

用法：python tools/build-data.py
依赖：pip install beautifulsoup4
改完 HTML 后跑一次，然后控制台热重载 dfy-chronicle（或重启宿主）即可。
"""
import json, re, shutil, datetime
from pathlib import Path
from bs4 import BeautifulSoup

PLUGIN = Path(__file__).resolve().parent.parent
SRC = Path(r"<工作目录>\调试编年史.html")
IMG = Path(r"<工作目录>\调试编年史-长图.png")
DATA = PLUGIN / "assets" / "chronicle.json"
ASSET = PLUGIN / "assets" / "chronicle.png"


def clean(s):
    return re.sub(r"\s+", " ", s or "").strip()


def txt(el):
    return clean(el.get_text(" ", strip=True)) if el else ""


def main():
    soup = BeautifulSoup(SRC.read_text(encoding="utf-8"), "html.parser")
    phases, incidents, numbers, evidence, rules, open_items = [], [], [], [], [], []

    for i, art in enumerate(soup.select("#timeline article.phase"), 1):
        when, card = art.select_one(".when"), art.select_one(".card")
        if not card:
            continue
        phases.append({
            "id": f"P{i}",
            "date": txt(when.select_one(".range")) if when else "",
            "ver": txt(when.select_one(".ver")) if when else "",
            "tag": txt(when.select_one(".tag")) if when else "",
            "title": txt(card.select_one("h3")),
            "lede": txt(card.select_one("p.lede")),
            "items": [txt(li) for li in card.select("ul li")],
            "metrics": [txt(m) for m in card.select(".metrics .metric")],
            "source": txt(card.select_one(".src")),
        })

    for i, tr in enumerate(soup.select("#incidents table tbody tr"), 1):
        tds = tr.find_all("td")
        if len(tds) < 4:
            continue
        name_el = tds[1]
        incidents.append({
            "id": f"I{i}", "time": txt(tds[0]),
            "name": txt(name_el.select_one(".name")) or txt(name_el),
            "flag": txt(name_el.select_one(".bad")),
            "cause": txt(tds[2]), "fix": txt(tds[3])
        })

    for i, row in enumerate(soup.select("#numbers .numrow"), 1):
        cells = [txt(x) for x in row.select(".k, .a, .b")]
        if len(cells) >= 3:
            numbers.append({"id": f"N{i}", "metric": cells[0], "before": cells[1], "after": cells[2]})

    for i, ev in enumerate(soup.select("#evidence .ev"), 1):
        h4 = ev.select_one("h4")
        title = txt(h4.contents[0]) if h4 and h4.contents else txt(h4)
        evidence.append({
            "id": f"E{i}", "title": title, "kind": txt(h4.select_one("span")) if h4 else "",
            "hint": txt(ev.select_one(".hint")),
            "items": [{"size": txt(li.select_one(".s")), "file": txt(li.select_one(".f")), "note": txt(li.select_one(".p"))} for li in ev.select("li")]
        })

    for i, rule in enumerate(soup.select("#rules .rule"), 1):
        rules.append({"id": f"R{i}", "text": txt(rule.select_one("p"))})

    for i, oi in enumerate(soup.select("#open .open-item"), 1):
        open_items.append({"id": f"O{i}", "what": txt(oi.select_one(".what")), "why": txt(oi.select_one(".why")), "status": txt(oi.select_one(".st"))})

    stats = [{"num": txt(s.select_one(".n")), "unit": txt(s.select_one(".u")), "label": txt(s.select_one(".l"))} for s in soup.select(".stats .stat")]

    data = {
        "id": "dfy-chronicle",
        "title": "本机调试编年史",
        "subtitle": txt(soup.select_one(".lede")),
        "span": "2026-10-27 → 2026-11-27",
        "days": 32, "versions": 8, "incidentCount": len(incidents), "extensionCount": 17,
        "stats": stats,
        "phases": phases, "incidents": incidents,
        "incidentNote": txt(soup.select_one("#incidents .tbl-note")),
        "numbers": numbers, "numberNote": txt(soup.select_one("#numbers .tbl-note")),
        "evidence": evidence,
        "gap": txt(soup.select_one("#evidence .tbl-note")),
        "rules": rules, "open": open_items,
        "sources": {
            "html": str(SRC), "image": str(IMG),
            "mainline": r"<工作目录>\记录\01-主线-0.4到0.5.1.md",
            "plans": r"<工作目录>\记录\02-方案与解析.md",
            "incidents": r"<工作目录>\记录\03-事故与修复.md",
            "monthly": r"<工作目录>\QQA-迭代历史-2026年11月.md",
            "latest": r"<工作目录>\记录\2026-11-26-OneBot未连接排障.md"
        },
        "builtAt": datetime.datetime.now().isoformat(timespec="seconds")
    }

    DATA.parent.mkdir(parents=True, exist_ok=True)
    DATA.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    ASSET.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(IMG, ASSET)
    print(f"ok: {len(phases)} phases / {len(incidents)} incidents / {len(numbers)} numbers -> {DATA}")


if __name__ == "__main__":
    main()
