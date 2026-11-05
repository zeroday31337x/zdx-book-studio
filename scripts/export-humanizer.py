#!/usr/bin/env python3
"""Read-only export of CodeBound chapters for isolated Humanizer processing."""
import argparse, hashlib, json, sqlite3
from pathlib import Path
p=argparse.ArgumentParser();p.add_argument('--output',required=True);a=p.parse_args()
source=Path('/srv/zdx-data/apps/book-studio/data/books.sqlite')
uri='file:'+str(source)+'?mode=ro'
with sqlite3.connect(uri,uri=True) as db:
    books=[(id,json.loads(raw)) for id,raw in db.execute('SELECT id,metadata FROM books')]
    matches=[id for id,b in books if b.get('title','').strip().lower()=='codebound']
    if len(matches)!=1:raise SystemExit('Expected exactly one CodeBound book; got '+str(len(matches)))
    rows=db.execute('SELECT number,data FROM chapters WHERE book_id=? AND number BETWEEN 1 AND 36 ORDER BY number',(matches[0],)).fetchall()
    result=[]
    for number,raw in rows:
        c=json.loads(raw);status=c.get('status');approved=c.get('approvedText') or '';draft=c.get('draft') or ''
        body=approved if status=='canon' else draft
        if not body:raise SystemExit('Missing chapter text: '+str(number))
        if status!='canon' and number!=36:raise SystemExit('Unexpected non-canon chapter: '+str(number))
        result.append({'number':number,'title':c.get('title') or 'Chapter '+str(number),'status':status,'text':body,'source_sha256':hashlib.sha256(body.encode()).hexdigest(),'structure':c.get('structure') or ''})
    if [r['number'] for r in result]!=list(range(1,37)):raise SystemExit('Missing/duplicate chapter numbers')
    if any(r['status']!='canon' for r in result[:35]):raise SystemExit('Chapters 1-35 must be canon')
    out=Path(a.output);out.parent.mkdir(parents=True,exist_ok=True);out.write_text(json.dumps({'book_id':matches[0],'title':'CodeBound','chapters':result},ensure_ascii=False),encoding='utf-8');out.chmod(0o600)
    print('Exported 36 chapters, 35 canon and one draft; bytes:',out.stat().st_size)
