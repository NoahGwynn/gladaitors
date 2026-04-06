"""Territory War adapter test.

Sends one turn of game state to all models and validates responses.
"""

import asyncio
from pathlib import Path

from dotenv import load_dotenv
load_dotenv(Path(__file__).parent / ".env")

from ai_adapter.adapter import AIAdapter, build_territory_war_prompts
from ai_adapter.schemas import TerritoryWarResponse
from game_engine.territory_war import TerritoryWarEngine


def print_result(result):
    status = "TIMEOUT" if result.timed_out else ("ERROR" if result.error else "OK")

    print(f"\n{'='*50}")
    print(f"  Model:    {result.model_name}")
    print(f"  Status:   {status}")
    print(f"  Latency:  {result.latency_ms:.0f}ms")
    print(f"  Tokens:   {result.input_tokens} in / {result.output_tokens} out")

    if result.error:
        print(f"  Error:    {result.error}")

    if result.response:
        for a in result.response.get("actions", []):
            parts = [f"Piece {a['unit_id']}: {a['action']}"]
            if a.get("direction"):
                parts.append(a["direction"])
            if a.get("target_id"):
                parts.append(f"target={a['target_id']}")
            parts.append(f"({a.get('reasoning', '')})")
            print(f"    {' '.join(parts)}")


async def main():
    model_names = ["Claude", "ChatGPT", "Gemini"]
    engine = TerritoryWarEngine(model_names)
    adapter = AIAdapter(response_schema=TerritoryWarResponse)

    print("gladAItors -- Territory War Adapter Test")
    print(f"Models: {', '.join(m.name for m in adapter.models)}")
    print(f"Grid: 20x20, Pieces per model: 3")

    state = engine.get_prompt_state()
    prompts = build_territory_war_prompts(state, model_names)

    print(f"\nCalling all models...")

    results = await adapter.call_all(prompts)
    for r in results:
        print_result(r)

    # Summary
    ok = sum(1 for r in results if r.response)
    print(f"\n{'='*50}")
    print(f"Result: {ok}/{len(results)} models returned valid actions")


if __name__ == "__main__":
    asyncio.run(main())
