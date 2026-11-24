"""Synthetic regressions for source vintage, preliminary designation and native table discipline."""
from pathlib import Path
import runpy
import unittest

scripts=Path(__file__).resolve().parents[1]/"scripts"
h6=runpy.run_path(str(scripts/"research-h6-retail-originals.py"))
pdf=runpy.run_path(str(scripts/"verify-h6-retail-pdfs.py"))
months=["2007-Dec.","2008-Jan.","Feb.","Mar.","Apr. p"]
values="10.0 20.0 30.0 4.0 6.0 10.0 5.0 45.0 1.0"
head="Table 4\nSEASONALLY ADJUSTED COMPONENTS OF NON-M1 M2\nBillions of dollars\nSavings deposits Small-denomination time deposits Retail funds\n"
text=head+"\n".join(m+"   "+values for m in months)+"\nWeek ending\n"
class H6Test(unittest.TestCase):
 def test_first_preliminary_month_is_a_genuine_original(self):
  html=("<i>Release Date: May 8, 2008</i><pre>"+text+"</pre>").encode()
  result=h6["parse_report"](html,"2008-05-08")
  self.assertEqual(result["2008-04"],("5.0","10.0"))
  self.assertEqual(max(result),"2008-04")
  self.assertRaises(ValueError,h6["parse_report"],html,"2008-05-09")
  self.assertRaises(ValueError,h6["parse_report"],html.replace(b"45.0",b"48.0"),"2008-05-08")
 def test_independent_layout_recovers_preliminary_month(self):
  found=pdf["rendered_pairs"](text)
  self.assertEqual([str(v) for v in found["2008-04"]],["5.0","10.0"])
  self.assertRaises(ValueError,pdf["rendered_pairs"],text.replace("SEASONALLY","NOT SEASONALLY"))
if __name__=="__main__":
 unittest.main()
