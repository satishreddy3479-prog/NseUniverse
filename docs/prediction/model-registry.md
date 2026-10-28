# Model registry (specification)

Status: specified; **not implemented** (no model exists). It will be one SQLite table plus model files, created with Milestone 4.

| Field | Meaning |
|---|---|
| model_name, version | for example `t1_logit_clim`, `0.1.0` |
| horizon | T1 or T5 (never shared) |
| training_cutoff | last date of training data |
| dataset_version, feature_version, label_version | hashes/ids of the exact inputs |
| hyperparameters, library versions, random seed | for reproduction |
| validation_metrics | per fold and pooled, with baselines |
| calibration | method and reliability summary |
| approval_status | `candidate`, `shadow`, `research-approved`, `retired` |
| known_limitations | free text, shown on the dashboard |
| artifact | path + sha256 of the serialized model |

Rules: a trained model starts as `candidate`; promotion to `shadow` and `research-approved` needs the gates in [forward-testing](forward-testing.md); the previously approved model is kept for rollback; nothing replaces it silently; model files are not committed to Git.
