export const browserWebGpuArgs = [
  "--enable-unsafe-webgpu",
  "--enable-features=Vulkan",
] as const;

export const softwareWebGpuArgs = [
  "--enable-unsafe-webgpu",
  "--enable-features=Vulkan",
  "--use-angle=swiftshader",
  "--use-webgpu-adapter=swiftshader",
] as const;
