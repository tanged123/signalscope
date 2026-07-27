//! MATLAB-dialect expression language for derived signals (ADR 0008).

use thiserror::Error;

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
#[cfg_attr(not(test), allow(dead_code))]
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
#[cfg_attr(not(test), allow(dead_code))]
struct Spanned {
    token: Token,
    start: usize,
    end: usize,
}

#[cfg_attr(not(test), allow(dead_code))]
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
                let quote = byte;
                index += 1;
                let text_start = index;
                while index < bytes.len() && bytes[index] != quote {
                    index += 1;
                }
                if index >= bytes.len() {
                    return Err(ExprError::UnterminatedString { start });
                }
                let name = src[text_start..index].to_owned();
                index += 1;
                if name.is_empty() {
                    return Err(ExprError::EmptySignal { start });
                }
                tokens.push(Spanned {
                    token: Token::Signal(name),
                    start,
                    end: index,
                });
            }
            b'0'..=b'9' | b'.'
                if byte != b'.' || matches!(bytes.get(index + 1), Some(b'0'..=b'9')) =>
            {
                while index < bytes.len() && (bytes[index].is_ascii_digit() || bytes[index] == b'.')
                {
                    index += 1;
                }
                if matches!(bytes.get(index), Some(b'e' | b'E'))
                    && matches!(bytes.get(index + 1), Some(b'0'..=b'9') | Some(b'+' | b'-'))
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
                let (token, width) = match (byte, bytes.get(index + 1)) {
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
                    _ => {
                        return Err(ExprError::UnexpectedCharacter {
                            character: src[index..].chars().next().unwrap_or('?'),
                            at: index,
                        });
                    }
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

#[cfg(test)]
mod tests {
    use super::*;

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
