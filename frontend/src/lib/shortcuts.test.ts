import { describe, expect, it } from "vitest";
import { shortcutFor } from "./shortcuts";

const press = (key: string, extra: Partial<KeyboardEvent> = {}, target: EventTarget | null = document.body) =>
  shortcutFor({ key, altKey: false, ctrlKey: false, metaKey: false, repeat: false, target, ...extra });

describe("shortcutFor", () => {
  it("maps single keys to actions, case-insensitively", () => {
    expect(press("2")).toBe("route-2");
    expect(press("d")).toBe("drive");
    expect(press("D")).toBe("drive");
    expect(press("?")).toBe("help");
    expect(press("x")).toBeNull();
  });

  it("never fires with modifiers, on key repeat, or while typing in a control", () => {
    expect(press("p", { metaKey: true })).toBeNull();
    expect(press("s", { ctrlKey: true })).toBeNull();
    expect(press("d", { repeat: true })).toBeNull();
    const input = document.createElement("input");
    document.body.append(input);
    expect(press("d", {}, input)).toBeNull();
    const slider = document.createElement("div");
    slider.setAttribute("role", "slider");
    document.body.append(slider);
    expect(press("1", {}, slider)).toBeNull();
  });
});
