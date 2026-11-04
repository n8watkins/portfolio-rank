// Runs in the browser before the app hydrates (Next.js instrumentation-client).
import { installErrorReporting } from "./lib/error-reporting";

installErrorReporting();
