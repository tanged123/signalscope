struct TileDirectory {
  point_start: u32,
  point_count: u32,
  series_slot: u32,
  tile_meta_index: u32,
};
struct SegmentDescriptor {
  first_point: u32,
  second_point: u32,
  series_slot: u32,
  tile_meta_index: u32,
};
struct Params {
  candidate_count: u32,
  directory_count: u32,
  reserved0: u32,
  reserved1: u32,
};

@group(0) @binding(0) var<storage, read> directories: array<TileDirectory>;
@group(0) @binding(1) var<storage, read> flags: array<u32>;
@group(0) @binding(2) var<storage, read> prefixes: array<u32>;
@group(0) @binding(3) var<storage, read_write> descriptors: array<SegmentDescriptor>;
@group(0) @binding(4) var<uniform> params: Params;

fn locate(candidate: u32) -> vec2<u32> {
  var base = 0u;
  for (var directory = 0u; directory < params.directory_count; directory += 1u) {
    let count = directories[directory].point_count;
    let edges = select(0u, count - 1u, count > 1u);
    if (candidate < base + edges) {
      return vec2<u32>(directory, candidate - base);
    }
    base += edges;
  }
  return vec2<u32>(0u, 0u);
}

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= params.candidate_count || flags[id.x] == 0u) {
    return;
  }
  let location = locate(id.x);
  let directory = directories[location.x];
  descriptors[prefixes[id.x]] = SegmentDescriptor(
    directory.point_start + location.y,
    directory.point_start + location.y + 1u,
    directory.series_slot,
    directory.tile_meta_index,
  );
}
