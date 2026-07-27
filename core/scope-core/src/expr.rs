//! MATLAB-dialect expression language for derived signals (ADR 0008).

use std::collections::BTreeMap;
use std::sync::Arc;

use thiserror::Error;

use crate::compute;
use crate::store::SignalStore;

/// Every way an expression can fail to parse or evaluate. Spans are byte
/// offsets into the source so the formula bar can underline the culprit.
#[derive(Clone, Debug, Error, PartialEq)]
pub enum ExprError {
    #[error("unexpected character {character:?}")]
    UnexpectedCharacter { character: char, at: usize },
    #[error("unterminated signal name")]
    UnterminatedString { start: usize },
    #[error("unexpected token")]
    UnexpectedToken { start: usize, end: usize },
    #[error("expression ended early")]
    UnexpectedEnd,
    #[error(
        "unknown name {name:?}{}",
        suggestion
            .as_ref()
            .map(|hint| format!(" - did you mean {hint:?}?"))
            .unwrap_or_default()
    )]
    UnknownIdentifier {
        name: String,
        suggestion: Option<String>,
        start: usize,
        end: usize,
    },
    #[error("unknown signal {0:?}")]
    UnknownSignal(String),
    #[error("reference at least one signal, for example hypot('imu/vx', 'imu/vy')")]
    NoReference,
    #[error("{name} takes {expected} argument(s), got {actual}")]
    BadArity {
        name: String,
        expected: usize,
        actual: usize,
    },
    #[error("{0} needs a literal positive whole-number window, for example movmean('x', 51)")]
    BadWindow(String),
    #[error("a signal name cannot be empty")]
    EmptySignal { start: usize },
}

#[derive(Clone, Debug, PartialEq)]
enum Token {
    Number(f64),
    Signal(String),
    Ident(String),
    LParen,
    RParen,
    Comma,
    Plus,
    Minus,
    Star,
    Slash,
    Caret,
    Lt,
    Le,
    Gt,
    Ge,
    EqEq,
    Ne,
    And,
    AndAnd,
    Or,
    OrOr,
    Not,
}

#[derive(Clone, Debug, PartialEq)]
struct Spanned {
    token: Token,
    start: usize,
    end: usize,
}

fn tokenize(src: &str) -> Result<Vec<Spanned>, ExprError> {
    let bytes = src.as_bytes();
    let mut tokens = Vec::new();
    let mut index = 0;
    while index < bytes.len() {
        let start = index;
        let byte = bytes[index];
        match byte {
            b' ' | b'\t' | b'\r' | b'\n' => {
                index += 1;
            }
            b'%' => {
                while index < bytes.len() && bytes[index] != b'\n' {
                    index += 1;
                }
            }
            b'\'' | b'"' => {
                let signal = quoted_signal(src, start)?;
                index = signal.end;
                tokens.push(signal);
            }
            b'0'..=b'9' | b'.'
                if byte != b'.' || matches!(bytes.get(index + 1), Some(b'0'..=b'9')) =>
            {
                while index < bytes.len() && (bytes[index].is_ascii_digit() || bytes[index] == b'.')
                {
                    index += 1;
                }
                if matches!(bytes.get(index), Some(b'e' | b'E'))
                    && matches!(bytes.get(index + 1), Some(b'0'..=b'9' | b'+' | b'-'))
                {
                    index += 2;
                    while index < bytes.len() && bytes[index].is_ascii_digit() {
                        index += 1;
                    }
                }
                let text = &src[start..index];
                let value = text
                    .parse::<f64>()
                    .map_err(|_| ExprError::UnexpectedToken { start, end: index })?;
                tokens.push(Spanned {
                    token: Token::Number(value),
                    start,
                    end: index,
                });
            }
            b'a'..=b'z' | b'A'..=b'Z' | b'_' => {
                while index < bytes.len()
                    && (bytes[index].is_ascii_alphanumeric() || bytes[index] == b'_')
                {
                    index += 1;
                }
                tokens.push(Spanned {
                    token: Token::Ident(src[start..index].to_owned()),
                    start,
                    end: index,
                });
            }
            _ => {
                let Some((token, width)) = operator(byte, bytes.get(index + 1)) else {
                    return Err(ExprError::UnexpectedCharacter {
                        character: src[index..].chars().next().unwrap_or('?'),
                        at: index,
                    });
                };
                index += width;
                tokens.push(Spanned {
                    token,
                    start,
                    end: index,
                });
            }
        }
    }
    Ok(tokens)
}

fn quoted_signal(src: &str, start: usize) -> Result<Spanned, ExprError> {
    let bytes = src.as_bytes();
    let quote = bytes[start];
    let mut index = start + 1;
    let mut name = String::new();
    while index < bytes.len() {
        if bytes[index] != quote {
            let character = src[index..]
                .chars()
                .next()
                .expect("index stays on a character boundary");
            name.push(character);
            index += character.len_utf8();
            continue;
        }
        if bytes.get(index + 1) == Some(&quote) {
            name.push(char::from(quote));
            index += 2;
            continue;
        }
        break;
    }
    if index >= bytes.len() {
        return Err(ExprError::UnterminatedString { start });
    }
    index += 1;
    if name.is_empty() {
        return Err(ExprError::EmptySignal { start });
    }
    Ok(Spanned {
        token: Token::Signal(name),
        start,
        end: index,
    })
}

fn operator(byte: u8, next: Option<&u8>) -> Option<(Token, usize)> {
    Some(match (byte, next) {
        (b'.', Some(b'*')) => (Token::Star, 2),
        (b'.', Some(b'/')) => (Token::Slash, 2),
        (b'.', Some(b'^')) => (Token::Caret, 2),
        (b'~', Some(b'=')) => (Token::Ne, 2),
        (b'<', Some(b'=')) => (Token::Le, 2),
        (b'>', Some(b'=')) => (Token::Ge, 2),
        (b'=', Some(b'=')) => (Token::EqEq, 2),
        (b'&', Some(b'&')) => (Token::AndAnd, 2),
        (b'|', Some(b'|')) => (Token::OrOr, 2),
        (b'(', _) => (Token::LParen, 1),
        (b')', _) => (Token::RParen, 1),
        (b',', _) => (Token::Comma, 1),
        (b'+', _) => (Token::Plus, 1),
        (b'-', _) => (Token::Minus, 1),
        (b'*', _) => (Token::Star, 1),
        (b'/', _) => (Token::Slash, 1),
        (b'^', _) => (Token::Caret, 1),
        (b'<', _) => (Token::Lt, 1),
        (b'>', _) => (Token::Gt, 1),
        (b'&', _) => (Token::And, 1),
        (b'|', _) => (Token::Or, 1),
        (b'~', _) => (Token::Not, 1),
        _ => return None,
    })
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
/// byte span of the offending token.
pub fn parse(src: &str) -> Result<Expr, ExprError> {
    let tokens = tokenize(src)?;
    let mut parser = Parser {
        tokens: &tokens,
        index: 0,
        next_call_id: 0,
    };
    let expr = parser.expression(0)?;
    if let Some(extra) = parser.peek_spanned() {
        return Err(ExprError::UnexpectedToken {
            start: extra.start,
            end: extra.end,
        });
    }
    Ok(expr)
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

    fn expression(&mut self, minimum: u8) -> Result<Expr, ExprError> {
        let mut lhs = self.prefix()?;
        while let Some((op, left, right)) = self.peek().and_then(infix_power) {
            if left < minimum {
                break;
            }
            self.index += 1;
            let rhs = self.expression(right)?;
            lhs = Expr::Binary {
                op,
                lhs: Box::new(lhs),
                rhs: Box::new(rhs),
            };
        }
        Ok(lhs)
    }

    fn prefix(&mut self) -> Result<Expr, ExprError> {
        let entry = self.advance()?;
        match entry.token {
            Token::Number(value) => Ok(Expr::Number(value)),
            Token::Signal(path) => Ok(Expr::Signal(path)),
            Token::Minus | Token::Plus | Token::Not => {
                let op = match entry.token {
                    Token::Minus => UnaryOp::Neg,
                    Token::Plus => UnaryOp::Pos,
                    _ => UnaryOp::Not,
                };
                let rhs = self.expression(UNARY_POWER)?;
                Ok(Expr::Unary {
                    op,
                    rhs: Box::new(rhs),
                })
            }
            Token::LParen => {
                let inner = self.expression(0)?;
                self.eat(&Token::RParen)?;
                Ok(inner)
            }
            Token::Ident(name) => self.identifier(name, entry.start, entry.end),
            _ => Err(ExprError::UnexpectedToken {
                start: entry.start,
                end: entry.end,
            }),
        }
    }

    fn identifier(&mut self, name: String, start: usize, end: usize) -> Result<Expr, ExprError> {
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
            };
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
        if self.peek() != Some(&Token::RParen) {
            loop {
                args.push(self.expression(0)?);
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
        Ok(Expr::Call {
            id,
            name,
            args,
            start,
            end: closing.end,
        })
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

/// A materialized derived signal on its base timebase.
#[derive(Clone, Debug, PartialEq)]
pub struct Evaluated {
    pub time: Arc<[f64]>,
    pub values: Vec<f64>,
}

struct Context {
    time: Arc<[f64]>,
    /// Every reference resampled onto `time`.
    resolved: BTreeMap<String, Vec<f64>>,
    /// Whole-signal results, keyed by the call node's id.
    whole: BTreeMap<usize, Vec<f64>>,
}

/// Evaluates `expr` against `store`.
///
/// # Errors
///
/// Returns [`ExprError::NoReference`] when the expression names no signal,
/// [`ExprError::UnknownSignal`] when a named signal is absent, and
/// [`ExprError::BadWindow`] when `movmean` lacks a literal window.
pub fn evaluate(expr: &Expr, store: &SignalStore) -> Result<Evaluated, ExprError> {
    let paths = references(expr);
    let base_path = paths.first().ok_or(ExprError::NoReference)?;
    let base = store
        .signal_by_path(base_path)
        .ok_or_else(|| ExprError::UnknownSignal(base_path.clone()))?;
    let time = base.time_shared();

    let mut resolved = BTreeMap::new();
    for path in &paths {
        let signal = store
            .signal_by_path(path)
            .ok_or_else(|| ExprError::UnknownSignal(path.clone()))?;
        let values = if Arc::ptr_eq(&signal.time_shared(), &time) {
            signal.values().to_vec()
        } else {
            time.iter()
                .map(|query| compute::lerp_at(signal.time(), signal.values(), *query))
                .collect()
        };
        resolved.insert(path.clone(), values);
    }

    let mut context = Context {
        time,
        resolved,
        whole: BTreeMap::new(),
    };
    materialize_whole(expr, &mut context)?;
    let values = materialize(expr, &context);
    Ok(Evaluated {
        time: context.time,
        values,
    })
}

/// Fills `context.whole` depth-first so an inner whole-signal op is ready
/// before the op that contains it materializes its argument.
fn materialize_whole(expr: &Expr, context: &mut Context) -> Result<(), ExprError> {
    match expr {
        Expr::Unary { rhs, .. } => materialize_whole(rhs, context),
        Expr::Binary { lhs, rhs, .. } => {
            materialize_whole(lhs, context)?;
            materialize_whole(rhs, context)
        }
        Expr::Call { id, name, args, .. } => {
            for arg in args {
                materialize_whole(arg, context)?;
            }
            let output = match name.as_str() {
                "gradient" => {
                    let input = materialize(&args[0], context);
                    compute::gradient(&context.time, &input)
                }
                "cumtrapz" => {
                    let input = materialize(&args[0], context);
                    compute::cumtrapz(&context.time, &input)
                }
                "movmean" => {
                    let Expr::Number(window) = &args[1] else {
                        return Err(ExprError::BadWindow(name.clone()));
                    };
                    if !window.is_finite() || *window < 1.0 || window.fract() != 0.0 {
                        return Err(ExprError::BadWindow(name.clone()));
                    }
                    let input = materialize(&args[0], context);
                    #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
                    compute::movmean(&input, *window as usize)
                }
                _ => return Ok(()),
            };
            context.whole.insert(*id, output);
            Ok(())
        }
        Expr::Number(_) | Expr::Time | Expr::Signal(_) => Ok(()),
    }
}

fn materialize(expr: &Expr, context: &Context) -> Vec<f64> {
    (0..context.time.len())
        .map(|index| scalar(expr, index, context))
        .collect()
}

fn scalar(expr: &Expr, index: usize, context: &Context) -> f64 {
    match expr {
        Expr::Number(value) => *value,
        Expr::Time => context.time[index],
        Expr::Signal(path) => context
            .resolved
            .get(path)
            .and_then(|values| values.get(index).copied())
            .unwrap_or(f64::NAN),
        Expr::Unary { op, rhs } => {
            let value = scalar(rhs, index, context);
            match op {
                UnaryOp::Neg => -value,
                UnaryOp::Pos => value,
                UnaryOp::Not => f64::from(u8::from(value == 0.0)),
            }
        }
        Expr::Binary { op, lhs, rhs } => {
            let left = scalar(lhs, index, context);
            let right = scalar(rhs, index, context);
            binary(*op, left, right)
        }
        Expr::Call { id, name, args, .. } => {
            if let Some(values) = context.whole.get(id) {
                return values.get(index).copied().unwrap_or(f64::NAN);
            }
            let first = scalar(&args[0], index, context);
            let second = args
                .get(1)
                .map_or(f64::NAN, |arg| scalar(arg, index, context));
            call(name, first, second)
        }
    }
}

fn truth(value: bool) -> f64 {
    if value { 1.0 } else { 0.0 }
}

#[allow(clippy::float_cmp)]
fn binary(op: BinaryOp, left: f64, right: f64) -> f64 {
    match op {
        BinaryOp::Add => left + right,
        BinaryOp::Sub => left - right,
        BinaryOp::Mul => left * right,
        BinaryOp::Div => left / right,
        BinaryOp::Pow => left.powf(right),
        BinaryOp::Lt => truth(left < right),
        BinaryOp::Le => truth(left <= right),
        BinaryOp::Gt => truth(left > right),
        BinaryOp::Ge => truth(left >= right),
        BinaryOp::Eq => truth(left == right),
        BinaryOp::Ne => truth(left != right),
        BinaryOp::And | BinaryOp::AndAnd => truth(left != 0.0 && right != 0.0),
        BinaryOp::Or | BinaryOp::OrOr => truth(left != 0.0 || right != 0.0),
    }
}

#[allow(clippy::float_cmp)]
fn call(name: &str, first: f64, second: f64) -> f64 {
    match name {
        "abs" => first.abs(),
        "sqrt" => first.sqrt(),
        "exp" => first.exp(),
        "log" => first.ln(),
        "log2" => first.log2(),
        "log10" => first.log10(),
        "sin" => first.sin(),
        "cos" => first.cos(),
        "tan" => first.tan(),
        "asin" => first.asin(),
        "acos" => first.acos(),
        "atan" => first.atan(),
        "atan2" => first.atan2(second),
        "sinh" => first.sinh(),
        "cosh" => first.cosh(),
        "tanh" => first.tanh(),
        "hypot" => first.hypot(second),
        "floor" => first.floor(),
        "ceil" => first.ceil(),
        "round" => first.round(),
        "fix" => first.trunc(),
        "sign" => {
            if first == 0.0 {
                0.0
            } else {
                first.signum()
            }
        }
        "mod" => first.rem_euclid(second),
        "rem" => first % second,
        "min" => first.min(second),
        "max" => first.max(second),
        "power" => first.powf(second),
        _ => f64::NAN,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::SignalStore;
    use std::sync::Arc;

    fn store_with(entries: &[(&str, &[f64], &[f64])]) -> SignalStore {
        let mut store = SignalStore::new();
        let source = store.register_source("test");
        for (path, time, values) in entries {
            let time: Arc<[f64]> = Arc::from(time.to_vec());
            store
                .insert_signal(source, *path, None, time, values.to_vec())
                .expect("inserts");
        }
        store
    }

    fn eval(src: &str, store: &SignalStore) -> Vec<f64> {
        evaluate(&parse(src).expect("parses"), store)
            .expect("evaluates")
            .values
    }

    #[test]
    #[allow(clippy::float_cmp)]
    fn evaluates_arithmetic_over_one_signal() {
        let store = store_with(&[("a/x", &[0.0, 1.0, 2.0], &[3.0, 4.0, 5.0])]);
        assert_eq!(eval("'a/x' * 2 + 1", &store), vec![7.0, 9.0, 11.0]);
        assert_eq!(eval("-'a/x'^2", &store), vec![-9.0, -16.0, -25.0]);
    }

    #[test]
    #[allow(clippy::float_cmp)]
    fn binds_t_to_the_sample_time() {
        let store = store_with(&[("a/x", &[0.0, 5.0, 10.0], &[1.0, 1.0, 1.0])]);
        assert_eq!(eval("'a/x' .* (t >= 5)", &store), vec![0.0, 1.0, 1.0]);
    }

    #[test]
    #[allow(clippy::float_cmp)]
    fn comparisons_yield_one_or_zero_and_nan_compares_false() {
        let store = store_with(&[("a/x", &[0.0, 1.0], &[f64::NAN, 3.0])]);
        assert_eq!(eval("'a/x' > 1", &store), vec![0.0, 1.0]);
        assert_eq!(eval("'a/x' == 'a/x'", &store), vec![0.0, 1.0]);
        assert_eq!(eval("'a/x' ~= 'a/x'", &store), vec![1.0, 0.0]);
    }

    #[test]
    #[allow(clippy::float_cmp)]
    fn resamples_later_references_onto_the_first_timebase() {
        let store = store_with(&[
            ("a/x", &[0.0, 1.0, 2.0], &[0.0, 0.0, 0.0]),
            ("a/y", &[0.0, 2.0], &[0.0, 20.0]),
        ]);
        assert_eq!(eval("'a/x' + 'a/y'", &store), vec![0.0, 10.0, 20.0]);
    }

    #[test]
    fn out_of_range_resampling_is_nan() {
        let store = store_with(&[
            ("a/x", &[0.0, 1.0, 2.0], &[0.0, 0.0, 0.0]),
            ("a/y", &[0.0, 1.0], &[5.0, 5.0]),
        ]);
        let values = eval("'a/x' + 'a/y'", &store);
        assert!(values[2].is_nan(), "past a/y's last sample");
    }

    #[test]
    #[allow(clippy::float_cmp)]
    fn whole_signal_ops_accept_nested_expressions() {
        let store = store_with(&[
            ("a/x", &[0.0, 1.0, 2.0], &[3.0, 3.0, 3.0]),
            ("a/y", &[0.0, 1.0, 2.0], &[4.0, 4.0, 4.0]),
        ]);
        assert_eq!(eval("hypot('a/x', 'a/y')", &store), vec![5.0, 5.0, 5.0]);
        assert_eq!(
            eval("gradient(hypot('a/x', 'a/y'))", &store),
            vec![0.0, 0.0, 0.0]
        );
    }

    #[test]
    #[allow(clippy::float_cmp)]
    fn movmean_takes_a_literal_window() {
        let store = store_with(&[("a/x", &[0.0, 1.0, 2.0], &[0.0, 3.0, 0.0])]);
        assert_eq!(eval("movmean('a/x', 3)", &store), vec![1.5, 1.0, 1.5]);
        let error = evaluate(&parse("movmean('a/x', 'a/x')").unwrap(), &store)
            .expect_err("needs a literal");
        assert_eq!(error, ExprError::BadWindow("movmean".into()));
    }

    #[test]
    #[allow(clippy::float_cmp)]
    fn sign_returns_zero_for_both_signed_zeros() {
        let store = store_with(&[("a/x", &[0.0, 1.0], &[-0.0, 0.0])]);
        assert_eq!(eval("sign('a/x')", &store), vec![0.0, 0.0]);
    }

    #[test]
    fn rejects_an_expression_with_no_signal_reference() {
        let store = store_with(&[("a/x", &[0.0], &[0.0])]);
        assert_eq!(
            evaluate(&parse("1 + 2").unwrap(), &store).unwrap_err(),
            ExprError::NoReference
        );
    }

    #[test]
    fn rejects_an_unknown_signal() {
        let store = store_with(&[("a/x", &[0.0], &[0.0])]);
        assert_eq!(
            evaluate(&parse("'a/missing' + 1").unwrap(), &store).unwrap_err(),
            ExprError::UnknownSignal("a/missing".into())
        );
    }

    #[test]
    fn references_are_reported_in_source_order_without_duplicates() {
        let expr = parse("'b/two' + 'a/one' + 'b/two'").unwrap();
        assert_eq!(references(&expr), vec!["b/two", "a/one"]);
    }

    /// Renders the tree in fully parenthesized prefix form so precedence
    /// assertions read as the shape they mean.
    fn shape(expr: &Expr) -> String {
        match expr {
            Expr::Number(value) => format!("{value}"),
            Expr::Time => "t".into(),
            Expr::Signal(path) => format!("@{path}"),
            Expr::Unary { op, rhs } => format!("({op:?} {})", shape(rhs)),
            Expr::Binary { op, lhs, rhs } => {
                format!("({op:?} {} {})", shape(lhs), shape(rhs))
            }
            Expr::Call { name, args, .. } => {
                let rendered: Vec<String> = args.iter().map(shape).collect();
                format!("({name} {})", rendered.join(" "))
            }
        }
    }

    #[test]
    fn power_binds_tighter_than_unary_minus() {
        assert_eq!(shape(&parse("-2^2").unwrap()), "(Neg (Pow 2 2))");
    }

    #[test]
    fn unary_minus_binds_tighter_than_multiplication() {
        assert_eq!(shape(&parse("-2*3").unwrap()), "(Mul (Neg 2) 3)");
    }

    #[test]
    fn power_is_right_associative() {
        assert_eq!(shape(&parse("2^3^2").unwrap()), "(Pow 2 (Pow 3 2))");
    }

    #[test]
    fn short_circuit_operators_bind_looser_than_elementwise() {
        assert_eq!(shape(&parse("1 || 2 | 3").unwrap()), "(OrOr 1 (Or 2 3))");
        assert_eq!(shape(&parse("1 && 2 & 3").unwrap()), "(AndAnd 1 (And 2 3))");
        assert_eq!(
            shape(&parse("1 || 2 && 3").unwrap()),
            "(OrOr 1 (AndAnd 2 3))"
        );
    }

    #[test]
    fn comparisons_bind_looser_than_arithmetic() {
        assert_eq!(shape(&parse("1 + 2 > 3").unwrap()), "(Gt (Add 1 2) 3)");
    }

    #[test]
    fn parses_constants_and_the_time_binding() {
        assert_eq!(shape(&parse("t").unwrap()), "t");
        assert_eq!(
            shape(&parse("pi").unwrap()),
            std::f64::consts::PI.to_string()
        );
        assert_eq!(shape(&parse("inf").unwrap()), "inf");
        assert_eq!(shape(&parse("Inf").unwrap()), "inf");
        assert!(matches!(parse("NaN").unwrap(), Expr::Number(value) if value.is_nan()));
    }

    #[test]
    fn parses_calls_and_signal_references() {
        assert_eq!(
            shape(&parse("hypot('a/x', 'a/y')").unwrap()),
            "(hypot @a/x @a/y)"
        );
        assert_eq!(
            shape(&parse("gradient(hypot('a/x', 'a/y'))").unwrap()),
            "(gradient (hypot @a/x @a/y))"
        );
    }

    #[test]
    fn assigns_each_call_a_distinct_id() {
        let expr = parse("gradient(movmean('a/x', 5))").unwrap();
        let Expr::Call {
            id: outer, args, ..
        } = &expr
        else {
            panic!("expected a call");
        };
        let Expr::Call { id: inner, .. } = &args[0] else {
            panic!("expected a nested call");
        };
        assert_ne!(outer, inner);
    }

    #[test]
    fn rejects_an_unknown_identifier_with_a_suggestion() {
        let error = parse("sqrtt('a/x')").expect_err("unknown name");
        assert!(matches!(
            error,
            ExprError::UnknownIdentifier {
                ref name,
                suggestion: Some(ref hint),
                ..
            } if name == "sqrtt" && hint == "sqrt"
        ));
    }

    #[test]
    fn rejects_trailing_tokens() {
        assert!(matches!(
            parse("1 2").expect_err("trailing"),
            ExprError::UnexpectedToken { .. }
        ));
    }

    #[test]
    fn rejects_an_empty_expression() {
        assert_eq!(
            parse("  % only a comment").unwrap_err(),
            ExprError::UnexpectedEnd
        );
    }

    #[test]
    fn tokenizes_signal_references_in_both_quote_styles() {
        let tokens = tokenize("'a/b' + \"c/d\"").expect("tokenizes");
        assert_eq!(
            tokens
                .iter()
                .map(|entry| entry.token.clone())
                .collect::<Vec<_>>(),
            vec![
                Token::Signal("a/b".into()),
                Token::Plus,
                Token::Signal("c/d".into()),
            ]
        );
    }

    #[test]
    fn doubled_delimiters_escape_quotes_in_signal_references() {
        let tokens = tokenize(r#"'pilot''s/"pitch"' + "pilot's/""pitch""""#).expect("tokenizes");
        assert_eq!(
            tokens
                .iter()
                .map(|entry| entry.token.clone())
                .collect::<Vec<_>>(),
            vec![
                Token::Signal(r#"pilot's/"pitch""#.into()),
                Token::Plus,
                Token::Signal(r#"pilot's/"pitch""#.into()),
            ]
        );
    }

    #[test]
    #[allow(clippy::float_cmp)]
    fn evaluates_a_signal_whose_path_contains_both_quote_styles() {
        let store = store_with(&[(r#"pilot's/"pitch""#, &[0.0, 1.0], &[2.0, 3.0])]);
        assert_eq!(eval(r#"'pilot''s/"pitch"' * 2"#, &store), vec![4.0, 6.0]);
    }

    #[test]
    fn doubled_delimiters_do_not_hide_an_unterminated_reference() {
        assert!(matches!(
            tokenize("'pilot''s/path").expect_err("unterminated"),
            ExprError::UnterminatedString { start: 0 }
        ));
    }

    #[test]
    fn skips_percent_comments_to_end_of_line() {
        let tokens = tokenize("1 % ignored 'x'\n+ 2").expect("tokenizes");
        assert_eq!(
            tokens
                .iter()
                .map(|entry| entry.token.clone())
                .collect::<Vec<_>>(),
            vec![Token::Number(1.0), Token::Plus, Token::Number(2.0)]
        );
    }

    #[test]
    fn tokenizes_matlab_operators() {
        let tokens = tokenize("~= .* ./ .^ <= >= == && || ~ & |").expect("tokenizes");
        assert_eq!(
            tokens
                .iter()
                .map(|entry| entry.token.clone())
                .collect::<Vec<_>>(),
            vec![
                Token::Ne,
                Token::Star,
                Token::Slash,
                Token::Caret,
                Token::Le,
                Token::Ge,
                Token::EqEq,
                Token::AndAnd,
                Token::OrOr,
                Token::Not,
                Token::And,
                Token::Or,
            ]
        );
    }

    #[test]
    fn tokenizes_numbers_with_exponents() {
        let tokens = tokenize("1 2.5 3e2 4.5e-3").expect("tokenizes");
        assert_eq!(
            tokens
                .iter()
                .map(|entry| entry.token.clone())
                .collect::<Vec<_>>(),
            vec![
                Token::Number(1.0),
                Token::Number(2.5),
                Token::Number(300.0),
                Token::Number(0.0045),
            ]
        );
    }

    #[test]
    fn reports_the_span_of_an_unterminated_string() {
        let error = tokenize("1 + 'a/b").expect_err("unterminated");
        assert!(matches!(error, ExprError::UnterminatedString { start: 4 }));
    }

    #[test]
    fn rejects_an_unexpected_character() {
        let error = tokenize("1 $ 2").expect_err("bad character");
        assert!(matches!(
            error,
            ExprError::UnexpectedCharacter {
                character: '$',
                at: 2
            }
        ));
    }
}
