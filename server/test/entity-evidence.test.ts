import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { entityEvidence } from '../src/risk/entityEvidence.ts'

test('实体观察：未知不当中性，源内去重及别名合并，来源均衡避免一家媒体淹没其他来源',t=>{
  const db=new DatabaseSync(':memory:');db.exec(readFileSync(new URL('../src/schema.sql',import.meta.url),'utf8'));t.after(()=>db.close())
  const now=Date.parse('2026-11-14T12:00:00Z'),at='2026-11-13T12:00:00Z'
  db.prepare('INSERT INTO sources(id,name,url,kind)VALUES(?,?,?,?)').run('s','test','https://example.com','rss')
  let i=0
  const add=(publisher:string,sentiment:string|null,entity='NVDA',title?:string)=>{
    i++;const url=`https://${publisher}.example/${i}`
    db.prepare('INSERT INTO raw_items(id,source_id,guid,url,url_norm,title,published_at,fingerprint,fetched_at)VALUES(?,?,?,?,?,?,?,?,?)')
      .run(i,'s',String(i),url,url,title??`Story ${i}`,at,String(i),at)
    db.prepare("INSERT INTO articles(id,raw_id,url,title,sentiment,published_at,created_at,category)VALUES(?,?,?,?,?,?,?,'model_release')").run(i,i,url,title??`Story ${i}`,sentiment,at,at)
    db.prepare('INSERT INTO mentions(article_id,entity)VALUES(?,?)').run(i,entity)
  }
  for(let n=0;n<30;n++)add('one','negative')
  for(let n=0;n<3;n++)add('two','neutral','英伟达')
  for(let n=0;n<10;n++)add('two',null,'NVIDIA')
  let r=entityEvidence(db,30,now)[0]
  assert.equal(r.mentions,43);assert.equal(r.classified,33);assert.equal(r.negativeShare,30/33);assert.equal(r.balancedShare,.5)
  add('one','negative','NVIDIA','Story 1')
  r=entityEvidence(db,30,now)[0];assert.equal(r.mentions,43)
  db.prepare('INSERT INTO mentions(article_id,entity)VALUES(?,?)').run(1,'英伟达')
  assert.equal(entityEvidence(db,30,now)[0].negative,30)
  for(let n=0;n<30;n++)add('two',null)
  assert.equal(entityEvidence(db,30,now)[0].balancedShare,null)
})
