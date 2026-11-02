<!--{"id":"results-who-won","order":4,"question":"Does Binchika announce results or say who won?","topics":["other","technical"],
"match":{"all_of":[["result*","won","win*","winner*","leading","tally","tallies","count*","declare*"]],"any_of":["who","when","official","announce*","declare*","inec","irev","live","show","projection","project*","final"],"never":["delete","my data","lawyer","court","complaint","error in your data","wrong figure"]},
"sources":[
{"page":"/tally/","must_contain":"This is a public ledger of citizen-reported tallies. Only INEC declares results."},
{"page":"/tally/","must_contain":"Binchika does not apply those rules or say who has won."},
{"page":"/tally/","must_contain":"Citizens photograph or report the posted result sheet. Binchika compares those reports with INEC's IReV uploads and writes high-agreement tallies to a public hash-chained ledger. Only INEC declares results."},
{"page":"/about/","must_contain":"A declaration of winners or projected victories"},
{"page":"/tally/","must_contain":"Pick a race to see the citizen-reported tallies beside the rules in the Constitution."}],
"link":"/tally/","risk":"low","auto_send":false,
"approved":"Owner decision of 30 Oct 2026 (session 80, K1): first answers drawn only from published pages","review_by":"2026-11-30"}-->
No. Only INEC declares results. Binchika does not declare winners or project victories.

Citizens photograph or report the posted result sheet. Binchika compares those reports with INEC's IReV uploads and writes high-agreement tallies to a public hash-chained ledger. The Live Tally Ledger on binchika.com/tally shows those citizen-reported tallies beside the rules in the Constitution; Binchika does not apply those rules or say who has won.
