@compute @workgroup_size(1)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  _ = id;
}
