#!/usr/bin/env python3
"""Builds data/cn_trademarks.txt.gz: live US trademark word marks whose current owner has a
China (CN) address, minus names that are also registered to owners elsewhere or that are
ordinary words.

Source: USPTO trademark case files (public domain) as Parquet on Hugging Face,
illeatmyhat/uspto-trademarks (built from USPTO TRTYRAP + TRTDXFAP). DuckDB reads only the
columns it needs over HTTP (a few hundred MB, not the 4 GB of files).

    python3 -m venv .venv && .venv/bin/pip install duckdb wordfreq
    .venv/bin/python tools/fetch-trademarks.py [cache.duckdb]

Rules for a kept name (key = uppercase letters/digits words joined by one space):
  - at least one live mark with a CN current owner, and no live mark with the same name
    (spaced or squashed together) owned from any other country
  - 4+ letters/digits once spaces are removed, at most 3 words
  - not made only of common words: a word counts as common if it's in the system
    dictionary, has English word frequency (wordfreq zipf) >= 2.5, appears in 20+ non-CN
    marks, is all digits, or is 1-2 characters long
"""
import collections, gzip, os, re, sys
import duckdb
from wordfreq import zipf_frequency

HF = "https://huggingface.co/datasets/illeatmyhat/uspto-trademarks/resolve/main/"
here = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
db = duckdb.connect(sys.argv[1] if len(sys.argv) > 1 else ":memory:")
db.execute("SET threads=4")  # leave the rest of the machine alone
db.execute("SET memory_limit='3GB'")
have = {r[0] for r in db.execute("select table_name from information_schema.tables").fetchall()}
if "own" not in have:
    files = lambda t, n: "[" + ",".join(f"'{HF}data/{t}/data_{i}.parquet'" for i in range(n)) + "]"
    db.execute(f"CREATE OR REPLACE TABLE status AS SELECT * FROM read_csv_auto('{HF}lookups/status_codes.csv', all_varchar=true)")
    db.execute(f"""CREATE OR REPLACE TABLE cf AS SELECT serial_no, mark_id_char, status_cd, registration_dt
      FROM read_parquet({files('case_file', 3)})
      WHERE mark_id_char IS NOT NULL AND status_cd IN (SELECT code FROM status WHERE live_dead_indicator ILIKE 'live%')""")
    # Current owner = the owner row with the highest party type code (later owners have higher codes).
    db.execute(f"""CREATE OR REPLACE TABLE own AS SELECT serial_no,
        arg_max(own_addr_country_cd, try_cast(own_type_cd as int)) country, arg_max(own_name, try_cast(own_type_cd as int)) name
      FROM read_parquet({files('owner', 3)}) WHERE serial_no IN (SELECT serial_no FROM cf) GROUP BY serial_no""")

rows = db.execute("select any_value(cf.mark_id_char), own.country from cf join own using(serial_no) group by cf.serial_no, own.country").fetchall()
tok = lambda m: re.findall(r"[A-Z0-9]+", m.upper())
cn, other, squashed_other, word_use = collections.Counter(), collections.Counter(), set(), collections.Counter()
for mark, country in rows:
    t = tok(mark)
    if not t: continue
    if country == "CN": cn[" ".join(t)] += 1
    else:
        other[" ".join(t)] += 1; squashed_other.add("".join(t))
        for w in set(t): word_use[w] += 1
dictionary = {w.strip().upper() for w in open("/usr/share/dict/words")}
def common(w):
    return w in dictionary or len(w) <= 2 or w.isdigit() or word_use[w] >= 20 or zipf_frequency(w.lower(), "en") >= 2.5
keep = []
for key in cn:
    words = key.split(" "); squashed = "".join(words)
    if other[key] or squashed in squashed_other: continue
    if len(squashed) < 4 or len(words) > 3: continue
    if all(common(w) for w in words): continue
    keep.append(key)
keep.sort()
with gzip.open(os.path.join(here, "data", "cn_trademarks.txt.gz"), "wt") as f:
    f.write("\n".join(keep) + "\n")
print(f"{len(cn)} CN-owned names, kept {len(keep)}")
