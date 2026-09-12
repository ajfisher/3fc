import { expect, type Page } from "@playwright/test";

export async function expectTeamTotalAlignment(page: Page, selector: string) {
  const geometry = await page.locator(selector).evaluateAll(elements => {
    const center = (rect: DOMRect) => rect.left + rect.width / 2;
    const textRect = (element: Element) => {
      const range = document.createRange(); range.selectNodeContents(element);
      return { rect: range.getBoundingClientRect(), fragments: range.getClientRects().length };
    };
    return { zoom: Number.parseFloat(getComputedStyle(document.documentElement).zoom) || 1,
      teams: elements.map(team => {
        const swatch = team.querySelector('[data-ui="team-swatch"]')!.getBoundingClientRect();
        const name = textRect(team.querySelector("header strong")!);
        return { id: team.getAttribute("data-team-id"),
          headingOffset: (Math.min(swatch.left, name.rect.left) + Math.max(swatch.right, name.rect.right)) / 2 - center(team.getBoundingClientRect()),
          totals: [...team.querySelectorAll("dt, dd")].map(element => {
            const text = textRect(element);
            return { text: element.textContent, offset: center(text.rect) - center(element.parentElement!.getBoundingClientRect()), fragments: text.fragments };
          }),
        };
      }),
    };
  });
  expect(geometry.teams.map(team => team.id)).toEqual(["red", "blue", "yellow"]);
  for (const team of geometry.teams) {
    expect(team.totals).toHaveLength(4);
    expect(Math.abs(team.headingOffset), `${team.id} heading and swatch are centred together`).toBeLessThanOrEqual(1.5 * geometry.zoom);
    for (const total of team.totals) {
      expect(total.fragments, `${team.id} ${total.text} is not fragmented`).toBe(1);
      expect(Math.abs(total.offset), `${team.id} ${total.text} is centred`).toBeLessThanOrEqual(1.5 * geometry.zoom);
    }
  }
}
