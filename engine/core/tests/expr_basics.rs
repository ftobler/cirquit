//! Unit behaviour of the expression parser and evaluator, relocated from
//! expr.rs so the implementation file stays near the line budget: precedence,
//! functions, state variables, and the named rejections for deep nesting.

use circuit_core::expr::{parse, ExprState};

fn state() -> ExprState {
    let mut s = ExprState::new();
    s.t = 2.0;
    s.time_step = 0.5;
    s.values[0] = 3.0;
    s.last_values[0] = 1.0;
    s
}

fn ev(input: &str) -> f64 {
    parse(input).unwrap().eval(&state())
}

#[test]
fn operator_precedence() {
    assert_eq!(ev("1 + 2 * 3"), 7.0);
    assert_eq!(ev("2 * 3 ^ 2"), 18.0);
    assert_eq!(ev("10 - 4 - 3"), 3.0);
    // `^` binds tighter than unary minus, so this is -(3^2).
    assert_eq!(ev("-3 ^ 2"), -9.0);
    // `^` is left-associative in the reference grammar, so (2^3)^2.
    assert_eq!(ev("2 ^ 3 ^ 2"), 64.0);
}

#[test]
fn ternary_and_logical_and_comparison_ops() {
    assert_eq!(ev("1 ? 10 : 20"), 10.0);
    assert_eq!(ev("0 ? 10 : 20"), 20.0);
    assert_eq!(ev("1 < 2 ? 3 : 4"), 3.0);
    assert_eq!(ev("1 && 0"), 0.0);
    assert_eq!(ev("1 || 0"), 1.0);
    assert_eq!(ev("!5"), 0.0);
    assert_eq!(ev("2 == 2"), 1.0);
    assert_eq!(ev("2 != 2"), 0.0);
    assert_eq!(ev("2 <= 1"), 0.0);
}

#[test]
fn bitwise_ops() {
    assert_eq!(ev("5 & 3"), 1.0);
    assert_eq!(ev("5 | 3"), 7.0);
    assert_eq!(ev("8 >> 2"), 2.0);
}

#[test]
fn shift_counts_mask_like_java() {
    // Java int shifts mask the count to its low five bits (JLS 15.19,
    // Expr.java:89), so dev, release and Java must agree bit for bit,
    // including counts Rust would panic on under debug assertions.
    assert_eq!(ev("8 >> 32"), 8.0); // count wraps to 0: identity shift
    assert_eq!(ev("8 >> 34"), 2.0); // low five bits say 2
    assert_eq!(ev("-1 >> 40"), -1.0); // arithmetic shift sign-extends
    assert_eq!(ev("8 >> -1"), 0.0); // -1 & 31 == 31
    assert_eq!(ev("-16 >> 31"), -1.0);
}

#[test]
fn functions() {
    assert_eq!(ev("sin(0)"), 0.0);
    assert_eq!(ev("min(3, 1, 2)"), 1.0);
    assert_eq!(ev("max(1, 5, 3)"), 5.0);
    assert_eq!(ev("clamp(5, 0, 3)"), 3.0);
    assert_eq!(ev("clamp(-5, 0, 3)"), 0.0);
    assert_eq!(ev("pwl(0.5, 0, 0, 2, 4)"), 1.0);
    assert_eq!(ev("pwl(-1, 0, 0, 2, 4)"), 0.0);
    assert_eq!(ev("select(-1, 10, 20)"), 10.0);
    assert_eq!(ev("select(2, 10, 20)"), 20.0);
    assert_eq!(ev("step(-2)"), 0.0);
    assert_eq!(ev("step(2)"), 1.0);
    assert_eq!(ev("mod(7, 3)"), 1.0);
    assert_eq!(ev("pwr(-2, 2)"), 4.0);
    assert_eq!(ev("pwrs(-2, 3)"), -8.0);
}

#[test]
fn constants_and_state() {
    let mut s = state();
    s.last_output = 7.0;
    assert_eq!(ev("pi"), std::f64::consts::PI);
    assert_eq!(ev("e"), std::f64::consts::E);
    assert_eq!(ev("t"), 2.0);
    assert_eq!(ev("timestep"), 0.5);
    assert_eq!(ev("dadt"), 4.0);
    assert_eq!(parse("lastoutput").unwrap().eval(&s), 7.0);
    assert_eq!(parse("lasta").unwrap().eval(&s), 1.0);
}

#[test]
fn input_is_lowercased_like_upstream() {
    assert_eq!(ev("SIN(0) + Abs(-1)"), 1.0);
}

#[test]
fn empty_input_evaluates_to_zero() {
    assert_eq!(ev(""), 0.0);
}

#[test]
fn rejects_bad_input() {
    assert!(parse("1 + * 2").is_err());
    assert!(parse("min(1)").is_err());
    assert!(parse("1 + 2 xyz").is_err());
    assert!(parse("(").is_err());
    // `sawtooth` is not a function; upstream spells it `saw`.
    assert!(parse("sawtooth(1)").is_err());
}

#[test]
fn deeply_nested_parentheses_error_instead_of_abort() {
    // Thousands of nested parens used to recurse the parser straight off
    // the wasm stack; the depth bound must turn that into a clean parse
    // error naming the nesting.
    let input = format!("{}1{}", "(".repeat(5000), ")".repeat(5000));
    let err = parse(&input).expect_err("deep nesting must be rejected");
    assert!(err.contains("nested"), "got: {err}");
}

#[test]
fn deep_ternary_chain_is_rejected_too() {
    // The ternary's else branch recurses rightward without consuming a
    // closing token, so it is unbounded exactly like the parens.
    let input = format!("{}0", "0?1:".repeat(5000));
    let err = parse(&input).expect_err("a deep ternary chain must be rejected");
    assert!(err.contains("nested"), "got: {err}");
}

#[test]
fn deep_unary_chain_is_rejected_too() {
    // Each `-` descends into parse_uminus again, so unary chains nest
    // without consuming operands either.
    let input = format!("-{}", "-".repeat(5000) + "1");
    let err = parse(&input).expect_err("a deep unary chain must be rejected");
    assert!(err.contains("nested"), "got: {err}");
}

#[test]
fn nesting_below_the_limit_still_parses() {
    // 50-deep parens sit under the 64 budget and must evaluate normally.
    let parens = format!("{}a{}", "(".repeat(50), ")".repeat(50));
    assert_eq!(parse(&parens).unwrap().eval(&state()), 3.0);
    // A flat argument list is sequential tokens, not depth: a 200-point
    // pwl call parses and interpolates at x = 100.5 between (100, 200)
    // and (101, 202).
    let mut pwl = String::from("pwl(100.5");
    for k in 0..200 {
        pwl.push_str(&format!(", {k}, {}", 2 * k));
    }
    pwl.push(')');
    assert_eq!(parse(&pwl).unwrap().eval(&state()), 201.0);
}
