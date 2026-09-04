use super::ExprError;

#[derive(Clone, Debug, PartialEq)]
pub(super) enum Token {
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
pub(super) struct Spanned {
    pub(super) token: Token,
    pub(super) start: usize,
    pub(super) end: usize,
}

pub(super) fn tokenize(src: &str) -> Result<Vec<Spanned>, ExprError> {
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
