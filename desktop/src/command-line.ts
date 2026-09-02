interface CommandLine {
  appendSwitch(name: string, value?: string): void;
}

export function configureCommandLine(
  commandLine: CommandLine,
  platform: NodeJS.Platform,
): void {
  commandLine.appendSwitch("disable-features", "AutofillServerCommunication");
  if (platform === "linux") commandLine.appendSwitch("enable-unsafe-webgpu");
}
