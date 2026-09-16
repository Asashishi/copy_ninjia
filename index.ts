import { ApplicationLifecycle } from "./packages/app/lifecycle";

export const application: ApplicationLifecycle = new ApplicationLifecycle();

if (import.meta.main) await application.run("main");
