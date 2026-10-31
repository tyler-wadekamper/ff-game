"""Reference check of browser feature extraction and weighted KNN pricing."""
import json
import numpy as np
import pandas as pd
from ffsim.adp import ADPModel, FEATURES, history_vector
from ffsim.data import add_derived

queries = json.load(open('artifacts/browser_market_queries.json'))
rows = []
max_feature = 0
for query in queries:
    player = query['player']
    records = [
        {'season': query['year'] - 1 + h['relative_season'],
         'position': player['position'], **h,
         'report_out_weeks': h['listed_out_weeks'] or 0}
        for h in player['history']
    ]
    history = add_derived(pd.DataFrame(records)) if records else pd.DataFrame(columns=['season'])
    features = history_vector(history, player['age'], query['year'])
    max_feature = max(max_feature, float(np.max(np.abs(features - query['features']))))
    rows.append({'position': player['position'], **dict(zip(FEATURES, features))})

neighbors = json.load(open('artifacts/adp_protocol.json'))['selected_neighbors']
model = ADPModel(2024, neighbors).fit(pd.read_csv('artifacts/adp_training_features.csv'))
predictions, _ = model.estimate(pd.DataFrame(rows))
difference = float(np.max(np.abs(predictions - np.array([q['priority'] for q in queries]))))
result = {
    'queries': len(queries), 'maxFeatureDifference': max_feature,
    'maxLogPriorityDifference': difference,
    'passed': max_feature < 1e-9 and difference < 1e-4,
    'reference': 'Independent Python/sklearn kernel and calendar history feature extraction',
}
with open('artifacts/browser_market_parity.json', 'w') as output:
    json.dump(result, output, indent=2)
print(result)
assert result['passed']
