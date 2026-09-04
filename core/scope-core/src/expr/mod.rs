//! MATLAB-dialect expression language for derived signals (ADR 0008).

mod eval;
mod lex;
mod parse;

use thiserror::Error;

pub use eval::{Evaluated, evaluate};
pub use parse::{BinaryOp, Expr, UnaryOp, parse, references, rename_references};

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

#[cfg(test)]
mod tests {
    use super::lex::{Token, tokenize};
    use super::*;
    use std::collections::BTreeMap;

    #[test]
    fn renaming_rewrites_only_signal_literals() {
        let map = BTreeMap::from([
            ("imu/ax".to_owned(), "run_a/imu/ax".to_owned()),
            ("imu/ay".to_owned(), "run_a/imu/ay".to_owned()),
        ]);
        let renamed = rename_references("hypot('imu/ax', 'imu/ay') + 2 * 'imu/az'", &map).unwrap();
        assert_eq!(
            renamed,
            "hypot('run_a/imu/ax', 'run_a/imu/ay') + 2 * 'imu/az'"
        );
        assert_eq!(references(&parse(&renamed).unwrap()).len(), 3);
    }

    #[test]
    fn renaming_never_touches_lookalike_text() {
        let map = BTreeMap::from([("a".to_owned(), "run/a".to_owned())]);
        assert_eq!(
            rename_references("abs('a') + 1", &map).unwrap(),
            "abs('run/a') + 1"
        );
    }

    #[test]
    fn quotes_inside_a_renamed_name_round_trip() {
        let map = BTreeMap::from([("it's".to_owned(), "run/it's".to_owned())]);
        let renamed = rename_references("'it''s'", &map).unwrap();
        assert_eq!(
            references(&parse(&renamed).unwrap()),
            vec!["run/it's".to_owned()]
        );
    }

    #[test]
    fn unparsable_expressions_are_not_partly_rewritten() {
        assert!(rename_references("'a' +", &BTreeMap::new()).is_err());
    }
    use crate::store::{SignalStore, SourceKey};
    use std::sync::Arc;

    fn store_with(entries: &[(&str, &[f64], &[f64])]) -> SignalStore {
        let mut store = SignalStore::new();
        let source = store
            .register_source("test", SourceKey(uuid::Uuid::from_bytes([1; 16])), "")
            .unwrap();
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
    fn converts_between_radians_and_degrees() {
        let store = store_with(&[(
            "a/x",
            &[0.0, 1.0, 2.0],
            &[0.0, std::f64::consts::PI, -std::f64::consts::FRAC_PI_2],
        )]);
        let degrees = eval("rad2deg('a/x')", &store);
        assert!((degrees[0] - 0.0).abs() < f64::EPSILON);
        assert!((degrees[1] - 180.0).abs() < f64::EPSILON);
        assert!((degrees[2] + 90.0).abs() < f64::EPSILON);

        let store = store_with(&[("a/x", &[0.0, 1.0, 2.0], &[0.0, 180.0, -90.0])]);
        let radians = eval("deg2rad('a/x')", &store);
        assert!((radians[0] - 0.0).abs() < f64::EPSILON);
        assert!((radians[1] - std::f64::consts::PI).abs() < f64::EPSILON);
        assert!((radians[2] + std::f64::consts::FRAC_PI_2).abs() < f64::EPSILON);
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
