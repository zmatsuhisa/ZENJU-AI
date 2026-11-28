import json, sys
t=json.load(open('label/truth.json')); pref={'hino':'hi','oribe':'or','senda':'se','numata':'nu'}
out=sys.argv[1]  # 出力フォルダの接尾辞
ok=n=fr=fn=0; bad=[]
for case in pref:
    rep=json.load(open(f'{case}/{out}/report.json'))
    # 位置で突き合わせる（番号が変わっても同じ書き込みを指すように、元の出力の箱の中心で合わせる）
    base=json.load(open(f'{case}/out/report.json'))
    for pb in base:
        pr=[p for p in rep if p['scan_page']==pb['scan_page']]
        if not pr: continue
        for ib in pb.get('items',[]):
            k=f"{pref[case]}{pb['scan_page']}-{ib['no']}"; tr=t.get(k,['?'])[0]
            if tr not in 'RN': continue
            bx,by,bw,bh=ib['box']; cx,cy=bx+bw/2,by+bh/2
            best=min(pr[0].get('items',[]), key=lambda i:(i['box'][0]+i['box'][2]/2-cx)**2+(i['box'][1]+i['box'][3]/2-cy)**2, default=None)
            if best is None: continue
            p='R' if best['judge']=='反映あり' else 'N'; n+=1; ok+=p==tr
            if tr=='N' and p=='R': fr+=1; bad.append(k)
            if tr=='R' and p=='N': fn+=1; bad.append(k)
print(f"{out}: 正解 {ok}/{n} = {ok/n:.0%} ／ 未反映を反映と誤判定 {fr} ／ 反映を未反映と誤判定 {fn} ／ 誤り {bad}")
