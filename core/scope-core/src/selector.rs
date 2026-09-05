use crate::store::{Signal, SignalStore};

pub(crate) fn matching_signals<'a>(
    store: &'a SignalStore,
    selector: &'a str,
) -> Option<impl Iterator<Item = &'a Signal>> {
    let selector = parse_selector(selector)?;
    Some(
        store
            .signals()
            .filter(move |signal| selector_matches(signal, &selector)),
    )
}

struct ParsedSelector<'a> {
    channel: ParsedGlob,
    source: Option<ParsedGlob>,
    attrs: Vec<(&'a str, &'a str)>,
}

struct ParsedGlob {
    branches: Vec<Vec<char>>,
}

fn parse_selector(selector: &str) -> Option<ParsedSelector<'_>> {
    let mut tokens = selector.split_whitespace();
    let channel = parse_glob(tokens.next()?)?;
    let mut source = None;
    let mut attrs = Vec::new();
    while let Some(token) = tokens.next() {
        if token == "@" || token.starts_with('@') {
            if source.is_some() {
                return None;
            }
            let pattern = if token == "@" {
                tokens.next()
            } else {
                token.get(1..)
            }?;
            if pattern.is_empty() {
                return None;
            }
            source = Some(parse_glob(pattern)?);
        } else {
            let (key, value) = token.split_once(':')?;
            if value.is_empty() || !matches!(key, "unit" | "kind") {
                return None;
            }
            if key == "kind" && !matches!(value, "derived" | "signal") {
                return None;
            }
            attrs.push((key, value));
        }
    }
    Some(ParsedSelector {
        channel,
        source,
        attrs,
    })
}

fn parse_glob(pattern: &str) -> Option<ParsedGlob> {
    let branches = pattern
        .split('|')
        .map(|branch| {
            let branch = branch.chars().collect::<Vec<_>>();
            let mut index = 0;
            while index < branch.len() {
                if branch[index] != '[' {
                    index += 1;
                    continue;
                }
                let end = branch[index + 1..]
                    .iter()
                    .position(|character| *character == ']')
                    .map(|offset| index + 1 + offset)?;
                let body = &branch[index + 1..end];
                let valid = body.len() == 1 && body[0].is_ascii_alphanumeric()
                    || body.len() == 3
                        && body[0].is_ascii_alphanumeric()
                        && body[1] == '-'
                        && body[2].is_ascii_alphanumeric();
                if !valid {
                    return None;
                }
                index = end + 1;
            }
            Some(branch)
        })
        .collect::<Option<Vec<_>>>()?;
    Some(ParsedGlob { branches })
}

fn selector_matches(signal: &Signal, selector: &ParsedSelector<'_>) -> bool {
    let channel = signal
        .path
        .strip_prefix("derived/")
        .unwrap_or(&signal.local_path);
    if !glob_matches(&selector.channel, channel) {
        return false;
    }

    if let Some(pattern) = &selector.source {
        let source_name = signal
            .path
            .split_once('/')
            .map_or("derived", |(source, _)| source);
        if !glob_matches(pattern, source_name) {
            return false;
        }
    }
    selector.attrs.iter().all(|(key, value)| match *key {
        "unit" => signal.unit.as_deref() == Some(value),
        "kind" => match *value {
            "derived" => signal.path.starts_with("derived/"),
            "signal" => !signal.path.starts_with("derived/"),
            _ => false,
        },
        _ => false,
    })
}

#[cfg(test)]
pub(crate) fn glob_pattern_matches(pattern: &str, value: &str) -> Option<bool> {
    Some(glob_matches(&parse_glob(pattern)?, value))
}

fn glob_matches(pattern: &ParsedGlob, value: &str) -> bool {
    let value = value.chars().collect::<Vec<_>>();
    pattern
        .branches
        .iter()
        .any(|branch| glob_branch_matches(branch, &value))
}

fn glob_branch_matches(pattern: &[char], value: &[char]) -> bool {
    fn matches_at(
        pattern: &[char],
        value: &[char],
        pattern_at: usize,
        value_at: usize,
        memo: &mut [Vec<Option<bool>>],
    ) -> bool {
        if let Some(matched) = memo[pattern_at][value_at] {
            return matched;
        }
        let matched = if pattern_at == pattern.len() {
            value_at == value.len()
        } else {
            match pattern[pattern_at] {
                '*' => {
                    matches_at(pattern, value, pattern_at + 1, value_at, memo)
                        || (value_at < value.len()
                            && matches_at(pattern, value, pattern_at, value_at + 1, memo))
                }
                '?' => {
                    value_at < value.len()
                        && matches_at(pattern, value, pattern_at + 1, value_at + 1, memo)
                }
                '[' => {
                    let Some(end) = pattern[pattern_at + 1..]
                        .iter()
                        .position(|character| *character == ']')
                        .map(|offset| pattern_at + 1 + offset)
                    else {
                        memo[pattern_at][value_at] = Some(false);
                        return false;
                    };
                    let body = &pattern[pattern_at + 1..end];
                    let valid = body.len() == 1 && body[0].is_ascii_alphanumeric()
                        || body.len() == 3
                            && body[0].is_ascii_alphanumeric()
                            && body[1] == '-'
                            && body[2].is_ascii_alphanumeric();
                    if !valid || value_at == value.len() {
                        false
                    } else {
                        let class_matches = if body.len() == 1 {
                            value[value_at] == body[0]
                        } else {
                            (body[0]..=body[2]).contains(&value[value_at])
                        };
                        class_matches && matches_at(pattern, value, end + 1, value_at + 1, memo)
                    }
                }
                character => {
                    value.get(value_at) == Some(&character)
                        && matches_at(pattern, value, pattern_at + 1, value_at + 1, memo)
                }
            }
        };
        memo[pattern_at][value_at] = Some(matched);
        matched
    }

    let mut memo = vec![vec![None; value.len() + 1]; pattern.len() + 1];
    matches_at(pattern, value, 0, 0, &mut memo)
}
