#!/usr/bin/env python3
"""
Fine-tuning Data Preparation Script
Converts raw conversation exports to JSONL format for Anthropic/OpenAI fine-tuning.

Usage:
  python scripts/fine-tuning/prepare_dataset.py \
    --input data/raw_conversations.json \
    --output data/training_set.jsonl \
    --provider anthropic \
    --min-quality 0.7
"""

import argparse
import json
import sys
from pathlib import Path
from typing import Iterator
import re

# ── Types ─────────────────────────────────────────────────────
def iter_conversations(filepath: str) -> Iterator[dict]:
    with open(filepath, 'r', encoding='utf-8') as f:
        data = json.load(f)
    convs = data if isinstance(data, list) else data.get('conversations', [])
    for conv in convs:
        yield conv

# ── Quality Filter ─────────────────────────────────────────────
def score_conversation(conv: dict) -> float:
    messages = conv.get('messages', [])
    if len(messages) < 2:
        return 0.0

    score = 1.0
    total_len = sum(len(m.get('content', '')) for m in messages)

    # Penalise very short responses
    if total_len < 50:
        score -= 0.5

    # Reward multi-turn
    if len(messages) >= 4:
        score += 0.1

    # Penalise refusals / low-quality
    for msg in messages:
        content = msg.get('content', '').lower()
        if any(phrase in content for phrase in ["i can't", "i'm unable", "i don't know"]):
            score -= 0.2

    return max(0.0, min(1.0, score))

# ── Format Converters ──────────────────────────────────────────
def to_anthropic_format(conv: dict, system_prompt: str) -> dict:
    """Anthropic fine-tuning JSONL format"""
    messages = []
    for msg in conv.get('messages', []):
        role = msg.get('role', 'user')
        if role == 'system':
            continue
        messages.append({'role': role, 'content': msg.get('content', '')})

    return {
        'system': system_prompt,
        'messages': messages,
    }

def to_openai_format(conv: dict, system_prompt: str) -> dict:
    """OpenAI fine-tuning JSONL format (chat completion)"""
    messages = [{'role': 'system', 'content': system_prompt}]
    for msg in conv.get('messages', []):
        role = msg.get('role', 'user')
        if role == 'system':
            continue
        messages.append({'role': role, 'content': msg.get('content', '')})

    return {'messages': messages}

# ── Tokenization Estimate ──────────────────────────────────────
def estimate_tokens(text: str) -> int:
    """Rough heuristic: ~4 chars per token"""
    return len(text) // 4

# ── Main ──────────────────────────────────────────────────────
def main():
    parser = argparse.ArgumentParser(description='Prepare fine-tuning dataset')
    parser.add_argument('--input',       required=True, help='Input JSON file')
    parser.add_argument('--output',      required=True, help='Output JSONL file')
    parser.add_argument('--provider',    choices=['anthropic', 'openai'], default='anthropic')
    parser.add_argument('--min-quality', type=float, default=0.6, help='Minimum quality score (0–1)')
    parser.add_argument('--system',      default='You are a helpful AI assistant.', help='System prompt')
    parser.add_argument('--max-tokens',  type=int, default=4096, help='Max tokens per example')
    parser.add_argument('--max-samples', type=int, default=10_000, help='Cap on output examples')
    args = parser.parse_args()

    input_path = Path(args.input)
    output_path = Path(args.output)
    output_path.parent.mkdir(parents=True, exist_ok=True)

    if not input_path.exists():
        print(f'❌ Input file not found: {input_path}', file=sys.stderr)
        sys.exit(1)

    total = filtered = written = 0
    formatter = to_anthropic_format if args.provider == 'anthropic' else to_openai_format

    with output_path.open('w', encoding='utf-8') as out:
        for conv in iter_conversations(str(input_path)):
            total += 1

            # Quality filter
            score = score_conversation(conv)
            if score < args.min_quality:
                filtered += 1
                continue

            # Format
            example = formatter(conv, args.system)
            example_text = json.dumps(example, ensure_ascii=False)

            # Token length filter
            if estimate_tokens(example_text) > args.max_tokens:
                filtered += 1
                continue

            out.write(example_text + '\n')
            written += 1

            if written >= args.max_samples:
                print(f'ℹ️  Reached max-samples limit ({args.max_samples})')
                break

    print(f'''
✅ Dataset preparation complete
   Provider : {args.provider}
   Total    : {total:,} conversations
   Filtered : {filtered:,} (quality < {args.min_quality} or too long)
   Written  : {written:,} training examples
   Output   : {output_path}
''')

if __name__ == '__main__':
    main()
