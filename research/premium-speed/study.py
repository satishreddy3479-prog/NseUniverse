import json, sys, numpy as np, pandas as pd
rows=[json.loads(l) for l in open(sys.argv[1])]
recs=[]
for r in rows:
    k=r["k"]; a=str(int(r["atm"]))
    recs.append(dict(d=r["d"],t=r["t"],dte=r["dte"],spot=r["spot"],atm=r["atm"],k=k,
        reg=(r["reg"][0] if r["reg"] else None),vol=(r["reg"][1] if r["reg"] else None),gam=(r["reg"][2] if r["reg"] else None)))
df=pd.DataFrame(recs)
df["m"]=df.t.str[:2].astype(int)*60+df.t.str[3:].astype(int)
out=[]
for d,g in df.groupby("d"):
    g=g.sort_values("m").reset_index(drop=True)
    idx={m:i for i,m in enumerate(g.m)}
    for i,r in g.iterrows():
        j=idx.get(r.m-5)
        if j is None: continue
        p=g.loc[j]
        a=str(int(r.atm))
        try:
            ce1,pe1=r.k[a]; ce0,pe0=p.k[a]
        except Exception: continue
        if None in (ce1,pe1,ce0,pe0) or ce0<=0 or pe0<=0: continue
        s1,s0=ce1+pe1,ce0+pe0
        out.append(dict(d=d,m=r.m,dte=r.dte,reg=r.reg,vol=r.vol,gam=r.gam,
            sp=abs(s1-s0)/s0*100, spS=(s1-s0)/s0*100, ce=abs(ce1-ce0)/ce0*100, pe=abs(pe1-pe0)/pe0*100,
            mv=abs(r.spot-p.spot)/p.spot*100, s0=s0, mvpts=abs(r.spot-p.spot)))
x=pd.DataFrame(out)
x["hb"]=pd.cut(x.m,[0,9*60+45,11*60,13*60,14*60+30,24*60],labels=["open","morn","mid","aft","close"])
x["dteb"]=pd.cut(x.dte,[-1,0,1,3,10],labels=["0d","1d","2-3d","4+d"])
print("n windows",len(x),"days",x.d.nunique())
pd.set_option("display.width",200)
print("\n== straddle |5-min change| % by DTE (all days)")
print(x.groupby("dteb",observed=True).sp.describe(percentiles=[.5,.9]).round(3))
print("\n== by time of day")
print(x.groupby("hb",observed=True).sp.describe(percentiles=[.5,.9]).round(3))
L=x[x.reg.notna()].copy()
print("\nlabelled windows",len(L),"days",L.d.nunique())
def tab(col,minn=60):
    t=L.groupby(col).agg(n=("sp","size"),days=("d","nunique"),med=("sp","median"),p90=("sp",lambda v:v.quantile(.9)),mv_med=("mv","median")).round(3)
    return t[t.n>=minn].sort_values("med",ascending=False)
for c in ("reg","vol","gam"):
    print(f"\n== straddle speed by {c} (>=60 windows)"); print(tab(c))
# regression: does regime add info beyond hour and DTE (and spot speed)?
import numpy.linalg as la
def r2(cols_df,y):
    X=np.column_stack([np.ones(len(y)),cols_df.values.astype(float)]); b,_,_,_=la.lstsq(X,y,rcond=None)
    res=y-X@b; return 1-res.var()/y.var(), X.shape[1]-1
L=L.dropna(subset=["sp","mv"]).copy(); L=L[(L.sp>0)]
y=np.log(L.sp.values)
base=pd.get_dummies(L[["hb","dteb"]].astype(str),drop_first=True)
r_base,_=r2(base,y)
withmv=base.copy(); withmv["lmv"]=np.log(L.mv.values+0.005)
r_mv,_=r2(withmv,y)
for c in ("reg","vol","gam"):
    dm=pd.get_dummies(L[c].astype(str),drop_first=True)
    r_c,k=r2(pd.concat([base,dm],axis=1),y)
    r_c2,k2=r2(pd.concat([withmv,dm],axis=1),y)
    print(f"{c}: R2 hour+DTE {r_base:.3f} -> +{c} {r_c:.3f} (+{r_c-r_base:.3f}, {k} dummies);  with spot speed {r_mv:.3f} -> +{c} {r_c2:.3f} (+{r_c2-r_mv:.3f})")
# per-day consistency: share of days where regime median > day median
print("\n== per-day consistency: for each market regime, share of (day) cells where its median speed beats that day's overall median")
for c in ("reg","vol","gam"):
    res=[]
    for lab,gg in L.groupby(c):
        wins=tot=0
        for d,g2 in gg.groupby("d"):
            if len(g2)<15: continue
            dm=L[L.d==d].sp.median(); tot+=1; wins+= g2.sp.median()>dm
        if tot>=3: res.append((lab,tot,round(wins/tot,2)))
    print(c,res)
# ratio premium response: straddle % move per % spot move (vega/gamma response) by regime
L["resp"]=L.sp/(L.mv+0.01)
print("\n== premium response (straddle % per 1% spot move, median) by market regime"); print(L.groupby("reg").resp.median().round(2).sort_values(ascending=False))
# time-of-day x DTE typical speed table for normalisation (the baseline cell sizes)
print("\n== baseline cell sizes (hour x DTE) over all days:"); print(pd.crosstab(x.hb,x.dteb))
