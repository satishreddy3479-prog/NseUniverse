import sqlite3, tempfile, json, sys
from pathlib import Path
from datetime import datetime, timezone, timedelta, date
tmp=Path(tempfile.mkdtemp())
for n in ("observations.sqlite3","intelligence.sqlite3"):
    s=sqlite3.connect(f"file:/var/lib/nse-universe/data/{n}?mode=ro",uri=True); d=sqlite3.connect(tmp/n); s.backup(d); d.close(); s.close()
o=sqlite3.connect(tmp/"observations.sqlite3"); i=sqlite3.connect(tmp/"intelligence.sqlite3")
IST=timezone(timedelta(hours=5,minutes=30))
def ist(ms): return datetime.fromtimestamp(ms/1000,timezone.utc).astimezone(IST)
reg={}
for at,r,v,g in i.execute("select at,regime,vol_regime,gamma_regime from timeline"):
    t=datetime.fromisoformat(at).astimezone(IST); reg[t.strftime("%Y-%m-%d %H:%M")]=(r,v,g)
rows=o.execute("select sample_id, expiry, received_ms, spot_p from samples where spot_p is not null order by received_ms").fetchall()
byday={}
for sid,exp,ms,sp in rows:
    t=ist(ms)
    if not (9*60+15 <= t.hour*60+t.minute <= 15*60+30) or t.weekday()>=5: continue
    byday.setdefault(t.date(),{}).setdefault(exp,[]).append((sid,t,sp/100))
out=[]
for day,exps in sorted(byday.items()):
    cands=[(e,l) for e,l in exps.items() if e>=day.isoformat() and len(l)>=300]
    if not cands: continue
    exp,lst=min(cands,key=lambda x:x[0])
    dte=(date.fromisoformat(exp)-day).days
    seen=set()
    for sid,t,spot in lst:
        key=t.strftime("%H:%M")
        if key in seen: continue
        seen.add(key)
        ks=[r[0] for r in o.execute("select distinct strike from contracts where sample_id=? ",(sid,))]
        if not ks: continue
        atm=min(ks,key=lambda k:abs(k-spot))
        step=50.0
        picks={}
        for r in o.execute("select strike,side,ltp_p from contracts where sample_id=? and strike between ? and ?",(sid,atm-4*step,atm+4*step)):
            picks.setdefault(r[0],[None,None])[r[1]]=None if r[2] is None else r[2]/100
        rg=reg.get(t.strftime("%Y-%m-%d %H:%M"))
        out.append({"d":day.isoformat(),"t":key,"exp":exp,"dte":dte,"spot":spot,"atm":atm,"reg":rg,"k":{str(int(k)):v for k,v in picks.items()}})
sys.stdout.write("\n".join(json.dumps(x) for x in out))
