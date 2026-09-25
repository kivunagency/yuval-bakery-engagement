// Bidi isolation for user-entered text placed inside Hebrew sentences
// (design-tokens.md, RTL section: fix bidi with direction/isolation, never by
// reordering characters). FIRST STRONG ISOLATE ... POP DIRECTIONAL ISOLATE:
// a product name or city in Latin letters ("Brownie", "QA City 1") keeps its
// own direction and does not pull the comma and the quantity after it into
// its run. Seen on the 390px checkout screenshot: "qa x, 3 יח׳" rendered as
// "3 ,qa x יח׳" before this.
export function isolate(text: string): string {
  return `⁨${text}⁩`;
}
