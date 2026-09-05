use std::collections::BTreeMap;

use super::{
    ExprError,
    lex::{Spanned, Token, tokenize},
};

const MAX_DEPTH: usize = 128;

fn checked_depth(depth: usize) -> Result<usize, ExprError> {
    if depth > MAX_DEPTH {
        Err(ExprError::TooDeep { limit: MAX_DEPTH })
    } else {
        Ok(depth)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum UnaryOp {
    Neg,
    Pos,
    Not,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BinaryOp {
    OrOr,
    AndAnd,
    Or,
    And,
    Lt,
    Le,
    Gt,
    Ge,
    Eq,
    Ne,
    Add,
    Sub,
    Mul,
    Div,
    Pow,
}

/// A parsed expression. `Call` nodes carry a unique `id` so the evaluator can
/// memoize the whole-signal operations without re-walking the tree.
#[derive(Clone, Debug, PartialEq)]
pub enum Expr {
    Number(f64),
    Time,
    Signal(String),
    Unary {
        op: UnaryOp,
        rhs: Box<Expr>,
    },
    Binary {
        op: BinaryOp,
        lhs: Box<Expr>,
        rhs: Box<Expr>,
    },
    Call {
        id: usize,
        name: String,
        args: Vec<Expr>,
        start: usize,
        end: usize,
    },
}

/// Per-sample scalar functions and their arity.
pub(crate) const SCALAR_FUNCTIONS: &[(&str, usize)] = &[
    ("abs", 1),
    ("sqrt", 1),
    ("exp", 1),
    ("log", 1),
    ("log2", 1),
    ("log10", 1),
    ("sin", 1),
    ("cos", 1),
    ("tan", 1),
    ("asin", 1),
    ("acos", 1),
    ("atan", 1),
    ("atan2", 2),
    ("sinh", 1),
    ("cosh", 1),
    ("tanh", 1),
    ("rad2deg", 1),
    ("deg2rad", 1),
    ("hypot", 2),
    ("floor", 1),
    ("ceil", 1),
    ("round", 1),
    ("fix", 1),
    ("sign", 1),
    ("mod", 2),
    ("rem", 2),
    ("min", 2),
    ("max", 2),
    ("power", 2),
];

/// Whole-signal operations. `movmean` takes a literal window as its second
/// argument; the others take one argument.
pub(crate) const WHOLE_FUNCTIONS: &[(&str, usize)] =
    &[("gradient", 1), ("cumtrapz", 1), ("movmean", 2)];

fn arity_of(name: &str) -> Option<usize> {
    SCALAR_FUNCTIONS
        .iter()
        .chain(WHOLE_FUNCTIONS.iter())
        .find(|(candidate, _)| *candidate == name)
        .map(|(_, arity)| *arity)
}

/// The closest known name by case-insensitive prefix and length, used only to
/// improve the error message.
fn suggest(name: &str) -> Option<String> {
    let lowered = name.to_ascii_lowercase();
    SCALAR_FUNCTIONS
        .iter()
        .chain(WHOLE_FUNCTIONS.iter())
        .map(|(candidate, _)| *candidate)
        .filter(|candidate| lowered.starts_with(candidate) || candidate.starts_with(&lowered))
        .min_by_key(|candidate| candidate.len().abs_diff(lowered.len()))
        .map(str::to_owned)
}

/// Parses `src` into an expression tree.
///
/// # Errors
///
/// Returns [`ExprError`] for any lexical or syntactic problem, carrying the
/// byte span of the offending token, or when nesting/tree depth exceeds 128.
pub fn parse(src: &str) -> Result<Expr, ExprError> {
    let tokens = tokenize(src)?;
    let mut parser = Parser {
        tokens: &tokens,
        index: 0,
        next_call_id: 0,
    };
    let (expr, _) = parser.expression(0, 1)?;
    if let Some(extra) = parser.peek_spanned() {
        return Err(ExprError::UnexpectedToken {
            start: extra.start,
            end: extra.end,
        });
    }
    Ok(expr)
}

/// Rewrites quoted signal references without changing surrounding syntax.
///
/// # Errors
///
/// Returns [`ExprError`] when the expression is invalid.
pub fn rename_references(src: &str, map: &BTreeMap<String, String>) -> Result<String, ExprError> {
    parse(src)?;
    let tokens = tokenize(src)?;
    let mut out = String::with_capacity(src.len());
    let mut cursor = 0;
    for spanned in tokens {
        let Token::Signal(name) = spanned.token else {
            continue;
        };
        let Some(replacement) = map.get(&name) else {
            continue;
        };
        out.push_str(&src[cursor..spanned.start]);
        out.push('\'');
        out.push_str(&replacement.replace('\'', "''"));
        out.push('\'');
        cursor = spanned.end;
    }
    out.push_str(&src[cursor..]);
    Ok(out)
}

struct Parser<'a> {
    tokens: &'a [Spanned],
    index: usize,
    next_call_id: usize,
}

/// MATLAB precedence, lowest first. The right value exceeds the left for
/// left-associative operators and trails it for right-associative ones.
fn infix_power(token: &Token) -> Option<(BinaryOp, u8, u8)> {
    Some(match token {
        Token::OrOr => (BinaryOp::OrOr, 1, 2),
        Token::AndAnd => (BinaryOp::AndAnd, 3, 4),
        Token::Or => (BinaryOp::Or, 5, 6),
        Token::And => (BinaryOp::And, 7, 8),
        Token::Lt => (BinaryOp::Lt, 9, 10),
        Token::Le => (BinaryOp::Le, 9, 10),
        Token::Gt => (BinaryOp::Gt, 9, 10),
        Token::Ge => (BinaryOp::Ge, 9, 10),
        Token::EqEq => (BinaryOp::Eq, 9, 10),
        Token::Ne => (BinaryOp::Ne, 9, 10),
        Token::Plus => (BinaryOp::Add, 11, 12),
        Token::Minus => (BinaryOp::Sub, 11, 12),
        Token::Star => (BinaryOp::Mul, 13, 14),
        Token::Slash => (BinaryOp::Div, 13, 14),
        Token::Caret => (BinaryOp::Pow, 18, 17),
        _ => return None,
    })
}

/// Unary operators sit between multiplication (13/14) and power (17/18), which
/// is what makes `-2^2` parse as `-(2^2)` and `-2*3` as `(-2)*3`.
const UNARY_POWER: u8 = 15;

impl Parser<'_> {
    fn peek_spanned(&self) -> Option<&Spanned> {
        self.tokens.get(self.index)
    }

    fn peek(&self) -> Option<&Token> {
        self.peek_spanned().map(|entry| &entry.token)
    }

    fn advance(&mut self) -> Result<Spanned, ExprError> {
        let entry = self
            .tokens
            .get(self.index)
            .ok_or(ExprError::UnexpectedEnd)?;
        self.index += 1;
        Ok(entry.clone())
    }

    fn eat(&mut self, expected: &Token) -> Result<(), ExprError> {
        let entry = self.advance()?;
        if &entry.token == expected {
            Ok(())
        } else {
            Err(ExprError::UnexpectedToken {
                start: entry.start,
                end: entry.end,
            })
        }
    }

    fn expression(&mut self, minimum: u8, nesting: usize) -> Result<(Expr, usize), ExprError> {
        checked_depth(nesting)?;
        let (mut lhs, mut depth) = self.prefix(nesting)?;
        while let Some((op, left, right)) = self.peek().and_then(infix_power) {
            if left < minimum {
                break;
            }
            self.index += 1;
            let (rhs, rhs_depth) = self.expression(right, nesting + 1)?;
            depth = checked_depth(depth.max(rhs_depth) + 1)?;
            lhs = Expr::Binary {
                op,
                lhs: Box::new(lhs),
                rhs: Box::new(rhs),
            };
        }
        Ok((lhs, depth))
    }

    fn prefix(&mut self, nesting: usize) -> Result<(Expr, usize), ExprError> {
        let entry = self.advance()?;
        match entry.token {
            Token::Number(value) => Ok((Expr::Number(value), 1)),
            Token::Signal(path) => Ok((Expr::Signal(path), 1)),
            Token::Minus | Token::Plus | Token::Not => {
                let op = match entry.token {
                    Token::Minus => UnaryOp::Neg,
                    Token::Plus => UnaryOp::Pos,
                    _ => UnaryOp::Not,
                };
                let (rhs, depth) = self.expression(UNARY_POWER, nesting + 1)?;
                let depth = checked_depth(depth + 1)?;
                Ok((
                    Expr::Unary {
                        op,
                        rhs: Box::new(rhs),
                    },
                    depth,
                ))
            }
            Token::LParen => {
                let inner = self.expression(0, nesting + 1)?;
                self.eat(&Token::RParen)?;
                Ok(inner)
            }
            Token::Ident(name) => self.identifier(name, entry.start, entry.end, nesting),
            _ => Err(ExprError::UnexpectedToken {
                start: entry.start,
                end: entry.end,
            }),
        }
    }

    fn identifier(
        &mut self,
        name: String,
        start: usize,
        end: usize,
        nesting: usize,
    ) -> Result<(Expr, usize), ExprError> {
        if self.peek() != Some(&Token::LParen) {
            return match name.as_str() {
                "t" => Ok(Expr::Time),
                "pi" => Ok(Expr::Number(std::f64::consts::PI)),
                "eps" => Ok(Expr::Number(f64::EPSILON)),
                "Inf" | "inf" => Ok(Expr::Number(f64::INFINITY)),
                "NaN" | "nan" => Ok(Expr::Number(f64::NAN)),
                _ => Err(ExprError::UnknownIdentifier {
                    suggestion: suggest(&name),
                    name,
                    start,
                    end,
                }),
            }
            .map(|expr| (expr, 1));
        }
        let Some(expected) = arity_of(&name) else {
            return Err(ExprError::UnknownIdentifier {
                suggestion: suggest(&name),
                name,
                start,
                end,
            });
        };
        self.eat(&Token::LParen)?;
        let mut args = Vec::new();
        let mut depth = 1;
        if self.peek() != Some(&Token::RParen) {
            loop {
                let (arg, arg_depth) = self.expression(0, nesting + 1)?;
                depth = depth.max(checked_depth(arg_depth + 1)?);
                args.push(arg);
                if self.peek() == Some(&Token::Comma) {
                    self.index += 1;
                } else {
                    break;
                }
            }
        }
        let closing = self.advance()?;
        if closing.token != Token::RParen {
            return Err(ExprError::UnexpectedToken {
                start: closing.start,
                end: closing.end,
            });
        }
        if args.len() != expected {
            return Err(ExprError::BadArity {
                name,
                expected,
                actual: args.len(),
            });
        }
        let id = self.next_call_id;
        self.next_call_id += 1;
        Ok((
            Expr::Call {
                id,
                name,
                args,
                start,
                end: closing.end,
            },
            depth,
        ))
    }
}

/// Every signal path the expression names, in source order, without repeats.
/// The first entry supplies the base timebase.
#[must_use]
pub fn references(expr: &Expr) -> Vec<String> {
    let mut found = Vec::new();
    collect_references(expr, &mut found);
    found
}

fn collect_references(expr: &Expr, found: &mut Vec<String>) {
    match expr {
        Expr::Signal(path) => {
            if !found.iter().any(|existing| existing == path) {
                found.push(path.clone());
            }
        }
        Expr::Unary { rhs, .. } => collect_references(rhs, found),
        Expr::Binary { lhs, rhs, .. } => {
            collect_references(lhs, found);
            collect_references(rhs, found);
        }
        Expr::Call { args, .. } => {
            for arg in args {
                collect_references(arg, found);
            }
        }
        Expr::Number(_) | Expr::Time => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bounded_expression_depth_accepts_the_limit_and_rejects_excess() {
        for (prefix, suffix) in [("-", ""), ("(", ")"), ("sin(", ")"), ("1^", ""), ("", "+1")] {
            let accepted = format!(
                "{}'a'{}",
                prefix.repeat(MAX_DEPTH - 1),
                suffix.repeat(MAX_DEPTH - 1)
            );
            let expr = parse(&accepted).expect("boundary expression parses");
            assert_eq!(references(&expr), vec!["a"]);
            let rejected = format!(
                "{}'a'{}",
                prefix.repeat(MAX_DEPTH),
                suffix.repeat(MAX_DEPTH)
            );
            assert!(
                matches!(
                    parse(&rejected),
                    Err(ExprError::TooDeep { limit: MAX_DEPTH })
                ),
                "{prefix} / {suffix}"
            );
            let excessive = format!("{}'a'{}", prefix.repeat(10_000), suffix.repeat(10_000));
            assert!(matches!(parse(&excessive), Err(ExprError::TooDeep { .. })));
        }
    }

    #[test]
    fn bounded_expression_depth_allows_large_balanced_trees() {
        let mut expression = "'a'".to_owned();
        for _ in 0..8 {
            expression = format!("({expression}+{expression})");
        }
        let expr = parse(&expression).expect("node count is not nesting depth");
        assert_eq!(references(&expr), vec!["a"]);
    }

    #[test]
    fn bounded_expression_depth_counts_mixed_tree_paths() {
        let left = format!("'a'{}", "+1".repeat(MAX_DEPTH - 1));
        for expression in [
            format!("-({left})"),
            format!("sin({left})"),
            format!("1+({left})"),
        ] {
            assert!(matches!(parse(&expression), Err(ExprError::TooDeep { .. })));
        }
    }
}
