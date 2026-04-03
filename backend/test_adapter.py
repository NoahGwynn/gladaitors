"""Step 1 — AI Adapter Proof of Concept.

Standalone script that calls all configured models simultaneously
with a Trading Pit-style prompt and logs results.
"""

import asyncio
import sys
from pathlib import Path

from dotenv import load_dotenv
load_dotenv(Path(__file__).parent / ".env")

from ai_adapter.adapter import AIAdapter, build_trading_pit_prompt


# Test scenario: a market tick with a news headline
TEST_STATE = {
    "tick": 0,
    "max_ticks": 40,
    "prices": {
        "Tech Stock": 142.50,
        "Energy": 87.20,
        "Gold": 203.00,
        "Crypto": 312.75,
        "Bonds": 98.40,
    },
    "headline": "Tech giant announces major AI partnership, shares expected to surge",
}


def print_result(result, run_number: int | None = None):
    prefix = f"[Run {run_number}] " if run_number else ""
    status = "TIMEOUT" if result.timed_out else ("ERROR" if result.error else "OK")

    print(f"\n{prefix}{'='*50}")
    print(f"  Model:    {result.model_name}")
    print(f"  Status:   {status}")
    print(f"  Latency:  {result.latency_ms:.0f}ms")
    print(f"  Tokens:   {result.input_tokens} in / {result.output_tokens} out")

    if result.error:
        print(f"  Error:    {result.error}")

    if result.response:
        for d in result.response["decisions"]:
            print(f"    {d['asset']:12s} -> {d['action']:4s}  {d['amount']:>5,}  ({d['reasoning']})")


async def single_run(adapter: AIAdapter, run_number: int | None = None) -> list:
    prompt = build_trading_pit_prompt(TEST_STATE)
    results = await adapter.call_all(prompt)
    for r in results:
        print_result(r, run_number)
    return results


async def main():
    num_runs = int(sys.argv[1]) if len(sys.argv) > 1 else 1
    adapter = AIAdapter()

    print(f"gladAItors — AI Adapter PoC")
    print(f"Models: {', '.join(m.name for m in adapter.models)}")
    print(f"Runs: {num_runs}")
    print(f"Timeout: 4s per call")

    all_results = []

    for i in range(1, num_runs + 1):
        results = await single_run(adapter, i if num_runs > 1 else None)
        all_results.extend(results)

        if i < num_runs:
            await asyncio.sleep(1)  # Brief pause between runs

    # Summary
    if num_runs > 1:
        print(f"\n{'='*50}")
        print("SUMMARY")
        print(f"{'='*50}")

        for model_name in {r.model_name for r in all_results}:
            model_results = [r for r in all_results if r.model_name == model_name]
            successes = sum(1 for r in model_results if r.response is not None)
            timeouts = sum(1 for r in model_results if r.timed_out)
            errors = sum(1 for r in model_results if r.error and not r.timed_out)
            avg_latency = sum(r.latency_ms for r in model_results) / len(model_results)

            print(f"\n  {model_name}:")
            print(f"    Success: {successes}/{num_runs}")
            print(f"    Timeouts: {timeouts}")
            print(f"    Errors: {errors}")
            print(f"    Avg latency: {avg_latency:.0f}ms")


if __name__ == "__main__":
    asyncio.run(main())
