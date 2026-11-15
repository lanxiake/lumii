import copy, importlib.util, json, os, shutil, tempfile, unittest
from contextlib import contextmanager
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
TMP=Path(os.environ.get('FY_SKILL_TEST_TMPDIR',str(Path(tempfile.gettempdir())/'fy-code-animation-tests')))
TMP.mkdir(parents=True,exist_ok=True)
@contextmanager
def tmp_dir():
 # 系统临时目录在受限环境下可能无法清理（Windows WinError 5）。
 # 测试断言不受影响；清理失败不应当让测试失败，也不往技能包里写任何东西。
 d=Path(tempfile.mkdtemp(dir=TMP))
 try: yield d
 finally:
  try: shutil.rmtree(d,ignore_errors=True)
  except OSError: pass
def module(name):
 s=importlib.util.spec_from_file_location(name,ROOT/'scripts'/f'{name}.py');m=importlib.util.module_from_spec(s);s.loader.exec_module(m);return m
sty=module('style_library');contract=module('validate_task')
class Checks(unittest.TestCase):
 def setUp(self): self.d=json.loads((ROOT/'templates/task.json').read_text(encoding='utf-8'))
 def test_walkthroughs(self):
  for p in (ROOT/'examples/tasks').glob('*.json'): self.assertEqual(contract.validate(json.loads(p.read_text(encoding='utf-8'))),[],p.name)
 def test_card_rejects_media(self):
  self.d['actions'].append('render_still');self.assertIn('action outside phase',contract.validate(self.d))
 def test_still_without_music_valid(self):
  self.d['phase']='still';self.d['actions'].append('render_still');self.assertEqual(contract.validate(self.d),[])
 def test_still_rejects_music(self):
  self.d['phase']='still';self.d['actions'].append('generate_local_music');self.assertIn('action outside phase',contract.validate(self.d))
 def test_false_measurement_rejected(self):
  self.d['events'][0]['time_basis']='measured';self.assertTrue(any('SHA256' in e for e in contract.validate(self.d)))
 def test_actual_sync_needs_audio(self):
  self.d['music']['actual_sync']=True;self.assertTrue(any('selected audio' in e for e in contract.validate(self.d)))
 def test_sync_rejects_unrelated_audio_evidence(self):
  self.d['music']={'actual_sync':True,'status':'selected','file':'selected.wav','source_sha256':'a'*64}
  self.d['events'][0].update(time_basis='measured',source_sha256='b'*64,evidence=['measured onset'])
  self.assertTrue(any('linked to selected' in e for e in contract.validate(self.d)))
 def test_malformed_phase_and_event_list_report_errors(self):
  self.d['phase']=[];self.assertEqual(contract.validate(self.d),['invalid phase'])
  self.d['phase']='card';self.d['events']=None;self.assertIn('events must be list',contract.validate(self.d))
 def test_short_reading_window_rejected(self):
  self.d['scenes'][0]['last_text_at']=7;self.assertTrue(any('reading window' in e for e in contract.validate(self.d)))
 def test_duplicate_id_and_half_open_event(self):
  self.d['scenes'].append(copy.deepcopy(self.d['scenes'][0]));self.d['events'][0]['at']=8
  es=contract.validate(self.d);self.assertIn('duplicate scene ID',es);self.assertIn('unexplained scene overlap',es);self.assertIn('event outside half-open scene',es)
 def test_invalid_fps_and_nan(self):
  self.d['fps']=True;self.d['scenes'][0]['end']=float('nan');self.assertTrue(contract.validate(self.d))
 def test_style_portability_and_full_text(self):
  with tmp_dir() as td:
   r=Path(td)/'中文目录'
   try:
    (r/'风格提示词/组').mkdir(parents=True);(r/'示例/X7_英雄漫画_示例').mkdir(parents=True)
   except OSError as e:
    self.skipTest('environment cannot create the CJK fixture (sandbox ACL?): '+str(e))
   text='完整提示词\n参数=12\n`demo/film.js`\n'
   (r/'风格提示词/组/X7_英雄漫画.md').write_text(text,encoding='utf-8',newline='');(r/'示例/X7_英雄漫画_示例/提示词.md').write_text('示例全文',encoding='utf-8')
   idx=sty.index_library(r);self.assertEqual(idx['prompt_count'],1)
   with self.assertRaisesRegex(ValueError,'AMBIGUOUS'):sty.select(idx,'X7')
   row=sty.select(idx,'X7','prompt');self.assertEqual(sty.read_row(r,row),text)
   self.assertEqual(sty.select(idx,'英雄漫画','prompt'),row);self.assertEqual(sty.select(idx,row['path']),row)
   self.assertEqual(sty.dependency_candidates(r,row,text)[0]['status'],'not_found_at_literal_path')
   moved=Path(td)/'移盘';r.rename(moved);self.assertEqual(sty.read_row(moved,row),text);self.assertEqual(sty.index_library(moved)['library_version'],idx['library_version'])
   (moved/row['path']).write_text('changed',encoding='utf-8')
   with self.assertRaisesRegex(ValueError,'VERSION_CHANGED'):sty.read_row(moved,row)
   with self.assertRaisesRegex(ValueError,'OUTSIDE'):sty.safe_file(moved,'../outside.md')
 def test_missing_library_or_style(self):
  with tmp_dir() as td:
   with self.assertRaisesRegex(ValueError,'MISSING_PROMPT'):sty.index_library(td)
  with self.assertRaisesRegex(ValueError,'NOT_FOUND'):sty.select({'entries':[]},'X99')
if __name__=='__main__': unittest.main(verbosity=2)
