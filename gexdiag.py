
lv=gx.levels(cs,spot,q,t,0.06); print({k:v for k,v in lv.items() if k.startswith('fd_') or k=='flip'}); print(gx.flip_support(spot,lv['flip'],{k[3:]:v for k,v in lv.items() if k.startswith('fd_')}))
