export function editorialPreparationMode(args: string[]) {
  if (args.length > 1 || (args.length === 1 && args[0] !== "--public-only" && args[0] !== "--weekday"))
    throw new Error("Usage: npm run editorial:prepare -- [--public-only | --weekday]");
  return {
    following: args.length === 0,
    freePriceAccount: args[0] !== "--public-only",
  };
}
