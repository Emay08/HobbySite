"""One-time: MTGO_treasure_chest_updates.xlsx -> vault-import.json"""
import json, re, sys, datetime, unicodedata, openpyxl

SRC, OUT = sys.argv[1], sys.argv[2]
DATE_FIX = {'Jan 16 2025': '2026-01-16'}  # confirmed typo in the tab name

def tab_date(title):
    if title in DATE_FIX: return DATE_FIX[title]
    t = title.strip().replace('Sept', 'Sep')
    for fmt in ('%b %d %Y', '%B %d %Y'):
        try: return datetime.datetime.strptime(t, fmt).date().isoformat()
        except ValueError: pass
    raise ValueError(f'Unrecognised tab name {title!r}')

def clean(v):
    return re.sub(r'\s+', ' ', str(v).replace('\xa0', ' ')).strip() if v is not None else ''

def num(v):
    if v is None or v == '': return None
    try: return float(v)
    except (TypeError, ValueError): return None

wb = openpyxl.load_workbook(SRC, data_only=True)
updates, warnings = [], []
for ws in wb.worksheets:
    if ws.title.lower() == 'buysell': continue
    date = tab_date(ws.title)
    header = [clean(c).lower() for c in next(ws.iter_rows(min_row=1, max_row=1, values_only=True))]
    has_t = 'treatment' in header[2]
    ci = dict(name=0, set=1, treatment=2 if has_t else None, slots=3 if has_t else 2, change=4 if has_t else 3)
    if not (header[ci['slots']].startswith('new') or header[ci['slots']].startswith('slots')):
        raise ValueError(f'{ws.title}: header not recognised: {header[:6]}')
    rows = []
    for r in ws.iter_rows(min_row=2, values_only=True):
        name = clean(r[ci['name']])
        if not name: continue
        slots = num(r[ci['slots']])
        if slots is None:
            warnings.append(f'{ws.title}: no slot count for {name}'); continue
        rows.append(dict(name=name, set=clean(r[ci['set']]).upper() if ci['set'] is not None else '',
                         treatment=clean(r[ci['treatment']]) if ci['treatment'] is not None else '',
                         slots=int(round(slots)),
                         change=(int(round(num(r[ci['change']]))) if ci['change'] is not None and num(r[ci['change']]) is not None else None)))
    updates.append(dict(date=date, tab=ws.title, hasTreatment=ci['treatment'] is not None, rows=rows))

updates.sort(key=lambda u: u['date'])

# ---- buysell: three columns, oldest at the top
ANN = re.compile(r'\(([^)]*)\)')
QTY = re.compile(r'(?:^|\s)x\s*(\d+)\b|\b(\d+)\s*x(?:\s|$)', re.I)
def parse_entry(raw):
    s = clean(raw)
    notes = [n.strip().lower() for n in ANN.findall(s)]
    s2 = ANN.sub(' ', s)
    qty = 1
    m = QTY.search(s2)
    if m:
        qty = int(m.group(1) or m.group(2)); s2 = QTY.sub(' ', s2, count=1)
    # version notes typed without brackets at the end: "strip mine VMA", "force of negation Retro"
    HINT = re.compile(r'^(retro|ext|extended|full|fullart|borderless|etched|foil|jap|japanese|prm|showcase)$', re.I)
    toks = s2.split()
    while len(toks) > 1 and (HINT.match(toks[-1]) or re.fullmatch(r'[A-Z0-9]{2,4}', toks[-1])):
        notes.append(toks.pop().lower())
    s2 = ' '.join(toks)
    words = ' '.join(notes).split()
    foil = any(w in ('f', 'foil', 'ff') for w in words)
    hints = ' '.join(w for w in words if w not in ('f', 'foil', 'ff')).strip()
    return dict(raw=s, text=re.sub(r'\s+', ' ', s2).strip(' ,-'), qty=qty, foil=foil, hints=hints)

trades = []
ws = wb['buysell']
COLS = [('rebought', 0, 'buy'), ('bought', 2, 'buy'), ('sold', 4, 'sell')]
for col_name, i, direction in COLS:
    seq = 0
    for r in ws.iter_rows(min_row=2, values_only=True):
        if r[i] is None or clean(r[i]) == '': continue
        e = parse_entry(r[i]); p = num(r[i + 1])
        trades.append(dict(column=col_name, seq=seq, direction=direction, price=p, **e))
        seq += 1

json.dump(dict(kind='vault-sheet-import', version=1, createdAt=datetime.datetime.now(datetime.UTC).isoformat().replace('+00:00', 'Z'),
               source=SRC.rsplit('/', 1)[-1], tcUpdates=updates, trades=trades), open(OUT, 'w'), ensure_ascii=False, indent=0)

# ---- report
print('updates', len(updates), updates[0]['date'], '->', updates[-1]['date'])
def key(r): return (unicodedata.normalize('NFKD', r['name']).encode('ascii', 'ignore').decode().lower(), r['set'], r['treatment'].lower())
prev = None; mism = 0
for u in updates:
    live = {key(r): r['slots'] for r in u['rows'] if r['slots'] > 0}
    zero = sum(1 for r in u['rows'] if r['slots'] == 0)
    bad = []
    if prev is not None:
        pk = prev if u['hasTreatment'] == prevT else {(k[0], k[1], k[2] if u['hasTreatment'] else ''): v for k, v in prev.items()}
        for r in u['rows']:
            if r['change'] is None: continue
            k = key(r) if u['hasTreatment'] else (key(r)[0], key(r)[1], '')
            if r['slots'] - pk.get(k, 0) != r['change']: bad.append(r['name'])
    mism += len(bad)
    print(f"{u['date']} ({u['tab']}): {len(live)} cards in chest, {sum(live.values())} slots, {zero} zero rows, change-column disagreements: {len(bad)} {bad[:4]}")
    prev, prevT = live, u['hasTreatment']
q = {}
for t in trades: q[t['column']] = q.get(t['column'], 0) + 1
print('trades', len(trades), q, 'no price', sum(1 for t in trades if t['price'] is None))
print('warnings', warnings[:10])
