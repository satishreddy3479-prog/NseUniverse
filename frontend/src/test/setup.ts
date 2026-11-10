import "@testing-library/jest-dom/vitest";
import { cleanup, configure } from "@testing-library/react";
import { afterEach } from "vitest";

afterEach(() => cleanup());

// Pages are loaded on demand (code splitting): the first render of a page in a fresh test file waits for its chunk, which can exceed the 1 s default.
configure({ asyncUtilTimeout: 15000 });
