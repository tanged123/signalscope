use std::{collections::BTreeMap, sync::Arc};

use crate::{compute, store::SignalStore};

use super::{BinaryOp, Expr, ExprError, UnaryOp, references};

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
        let values = if signal.timebase_id() == base.timebase_id() {
            signal.values().to_vec()
        } else {
            let signal_time = signal.time();
            let signal_values = signal.values();
            time.iter()
                .map(|query| compute::lerp_at(&signal_time, &signal_values, *query))
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
        "rad2deg" => first.to_degrees(),
        "deg2rad" => first.to_radians(),
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
