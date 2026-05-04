// Curated suggested-prompt pools, grouped by which specialist the prompt
// is intended to exercise. samplePrompts() returns one prompt per group on
// every call, so the four chips shown at startup vary across page loads.
//
// When forking to another domain: replace the prompt strings to match your
// own example data and tools. Keep the four-group structure so the demo
// still showcases delegation across all specialists.

type Group = "concierge" | "catalog" | "butler" | "planner";

const POOL: Record<Group, string[]> = {
  concierge: [
    "What can you help me with?",
    "How does this work?",
    "Tell me about yourself",
    "What kind of catalogue do you have?",
    "Help — I don't know where to start",
  ],
  catalog: [
    "Find healthy snacks under $5",
    "Show me gluten-free options",
    "Something quick for a school lunchbox",
    "What cheeses do you carry?",
    "Vegetarian protein sources",
    "Items under $3 for breakfast",
    "Frozen meals for a busy week",
    "Pantry staples for an Italian dinner",
  ],
  butler: [
    "I'm vegetarian and have two kids",
    "Remember that I'm dairy-free",
    "We're a household of four",
    "I shop on a $100 weekly budget",
    "What do you remember about me?",
    "Note that I avoid red meat",
    "I prefer organic produce when possible",
  ],
  planner: [
    "Plan a $30 vegetarian dinner for four",
    "Build me a weekly shopping list",
    "Recipe and ingredients for spaghetti bolognese",
    "Plan three school lunchboxes for the week",
    "$50 grocery run for a family of four",
    "Quick weeknight dinner under $25",
    "Healthy breakfast plan for the week",
  ],
};

const ORDER: Group[] = ["concierge", "catalog", "butler", "planner"];

function pick<T>(arr: readonly T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

/**
 * Return one prompt from each group, in a stable order
 * (concierge, catalog, butler, planner). Re-randomises every call.
 */
export function samplePrompts(): string[] {
  return ORDER.map((g) => pick(POOL[g]));
}
