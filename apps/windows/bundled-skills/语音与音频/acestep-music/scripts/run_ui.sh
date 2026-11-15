#!/bin/bash
cd /e/ai
./python_embeded/python.exe -m acestep.acestep_v15_pipeline \
  --port 7861 \
  --server-name 127.0.0.1 \
  --language zh \
  --config_path acestep-v15-turbo \
  --lm_model_path acestep-5Hz-lm-1.7B \
  --init_service true \
  --init_llm auto \
  > /e/ai/downloads/ui.log 2>&1
