//! Expression evaluation depth safety: a flat operator chain nests its tree
//! one level per term, far past the parser's grammar bound, so evaluation
//! must not recurse the native stack; mixed-precedence results must match a
//! straightforward recursive reference evaluator.

use circuit_core::expr::{parse, ExprState};

fn state() -> ExprState {
    let mut s = ExprState::new();
    s.t = 1.7;
    s.time_step = 0.25;
    s.last_output = 0.4;
    for (i, v) in [3.0, 5.0, 7.0, 11.0, 13.0, 17.0, 19.0, 23.0, 29.0]
        .iter()
        .enumerate()
    {
        s.values[i] = *v;
        s.last_values[i] = *v * 0.5;
    }
    s
}

#[test]
fn flat_addition_chain_a_hundred_thousand_terms_wide_evaluates() {
    // A flat chain parses into a left-leaning tree one level per term, well
    // past any grammar nesting bound; evaluation must walk it iteratively,
    // and dropping it afterwards must not recurse either.
    let input = "1 + ".repeat(100_000) + "1";
    let e = parse(&input).expect("a flat chain must parse");
    assert_eq!(e.eval(&state()), 100_001.0);
}

#[test]
fn deep_chain_inside_function_args_and_ternary_branches() {
    // The iterative walk has to hold for subtrees parked under control-flow
    // nodes too: a pwl abscissa and a ternary then-branch that are each long
    // flat chains of their own.
    let deep = "1 + ".repeat(20_000) + "1";
    let pwl = format!("pwl(2 + {deep}, 0, 0, 1, 10)");
    assert_eq!(parse(&pwl).unwrap().eval(&state()), 10.0);
    let ternary = format!("t ? 2 * ({deep}) : 5");
    assert_eq!(parse(&ternary).unwrap().eval(&state()), 40_002.0);
}

#[test]
fn flat_mixed_precedence_chain_keeps_binding_rules() {
    // `*` must bind tighter than `+` at every step of a long flat chain: each
    // unit contributes 2*3, so n units after the leading 1 sum to 6n + 1,
    // not the left-to-right reading of the same tokens.
    let n = 50_000;
    let input = String::from("1") + &" + 2*3".repeat(n);
    assert_eq!(parse(&input).unwrap().eval(&state()), 1.0 + 6.0 * n as f64);
    // Subtraction stays left-associative across the chain.
    let input = String::from("100000") + &" - 1".repeat(n);
    assert_eq!(parse(&input).unwrap().eval(&state()), 100_000.0 - n as f64);
}

#[test]
fn pwl_walk_reaches_later_segments_and_holds_past_the_end() {
    let s = state();
    // Lands between the third pair's points, so the walk must advance two
    // segment pairs before interpolating.
    assert_eq!(
        parse("pwl(2.5, 0, 0, 1, 10, 2, 20, 3, 30, 4, 40)")
            .unwrap()
            .eval(&s),
        25.0
    );
    // Past the last abscissa the last ordinate holds.
    assert_eq!(parse("pwl(9, 0, 0, 1, 10, 2, 20)").unwrap().eval(&s), 20.0);
}

#[test]
fn random_expressions_match_a_recursive_reference() {
    // Generated expressions covering every operator exercise the iterative
    // scheduling order against an independent recursive evaluator written
    // straight from the precedence table.
    let mut rng = Rng::new(0xDEED_BEEF_1234_5678);
    for _ in 0..4000 {
        let text = gen_top(&mut rng, 4);
        let want = reference_eval(&text, &state());
        let got = parse(&text)
            .unwrap_or_else(|e| panic!("generated expression refused: {text}: {e}"))
            .eval(&state());
        assert!(
            same(got, want),
            "mismatch on {text}: engine {got}, reference {want}"
        );
    }
}

fn same(a: f64, b: f64) -> bool {
    a == b || (a.is_nan() && b.is_nan())
}

/// Tiny xorshift64*, enough for deterministic expression generation without
/// pulling in a rand crate.
struct Rng(u64);

impl Rng {
    fn new(seed: u64) -> Self {
        Self(seed)
    }
    fn next_u32(&mut self) -> u32 {
        let mut x = self.0;
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        self.0 = x;
        (x >> 32) as u32
    }
    fn below(&mut self, n: u32) -> u32 {
        self.next_u32() % n
    }
    fn chance(&mut self, pct: u32) -> bool {
        self.below(100) < pct
    }
    fn pick<'a>(&mut self, choices: &[&'a str]) -> &'a str {
        choices[self.below(choices.len() as u32) as usize]
    }
}

const ATOM_LETTERS: [&str; 7] = ["a", "b", "c", "d", "f", "g", "h"];

fn atom(rng: &mut Rng) -> String {
    if rng.chance(60) {
        if rng.chance(30) {
            format!("{}", rng.below(10))
        } else {
            format!("{}.{}", rng.below(10), rng.below(10))
        }
    } else if rng.chance(15) {
        "t".to_string()
    } else {
        ATOM_LETTERS[rng.below(ATOM_LETTERS.len() as u32) as usize].to_string()
    }
}

// Each generator tier mirrors one parser level, including which tiers chain
// left-associatively and which take a single optional operator.
fn gen_top(rng: &mut Rng, d: u32) -> String {
    let e = gen_or(rng, d);
    if d > 0 && rng.chance(12) {
        format!("{e} ? {} : {}", gen_or(rng, d - 1), gen_top(rng, d - 1))
    } else {
        e
    }
}

fn gen_or(rng: &mut Rng, d: u32) -> String {
    let mut e = gen_and(rng, d);
    while d > 0 && rng.chance(15) {
        e += " || ";
        e += &gen_and(rng, d - 1);
    }
    e
}

fn gen_and(rng: &mut Rng, d: u32) -> String {
    let mut e = gen_bit_or(rng, d);
    while d > 0 && rng.chance(15) {
        e += " && ";
        e += &gen_bit_or(rng, d - 1);
    }
    e
}

fn gen_bit_or(rng: &mut Rng, d: u32) -> String {
    let mut e = gen_bit_and(rng, d);
    while d > 0 && rng.chance(12) {
        e += " | ";
        e += &gen_bit_and(rng, d - 1);
    }
    e
}

fn gen_bit_and(rng: &mut Rng, d: u32) -> String {
    let mut e = gen_eq(rng, d);
    while d > 0 && rng.chance(12) {
        e += " & ";
        e += &gen_eq(rng, d - 1);
    }
    e
}

fn gen_eq(rng: &mut Rng, d: u32) -> String {
    let e = gen_cmp(rng, d);
    if d > 0 && rng.chance(15) {
        format!("{e} == {}", gen_cmp(rng, d - 1))
    } else {
        e
    }
}

fn gen_cmp(rng: &mut Rng, d: u32) -> String {
    let e = gen_shift(rng, d);
    if d > 0 && rng.chance(20) {
        format!(
            "{e} {} {}",
            rng.pick(&["<=", ">=", "!=", "<", ">"]),
            gen_shift(rng, d - 1)
        )
    } else {
        e
    }
}

fn gen_shift(rng: &mut Rng, d: u32) -> String {
    let mut e = gen_add(rng, d);
    while d > 0 && rng.chance(10) {
        e += " >> ";
        e += &gen_add(rng, d - 1);
    }
    e
}

fn gen_add(rng: &mut Rng, d: u32) -> String {
    let mut e = gen_mult(rng, d);
    while d > 0 && rng.chance(40) {
        e += rng.pick(&[" + ", " - "]);
        e += &gen_mult(rng, d - 1);
    }
    e
}

fn gen_mult(rng: &mut Rng, d: u32) -> String {
    let mut e = gen_unary(rng, d);
    while d > 0 && rng.chance(35) {
        e += rng.pick(&[" * ", " / ", " % "]);
        e += &gen_unary(rng, d - 1);
    }
    e
}

fn gen_unary(rng: &mut Rng, d: u32) -> String {
    let prefix = if rng.chance(15) { "-" } else { "" };
    let prefix = if prefix.is_empty() && rng.chance(10) {
        "!"
    } else {
        prefix
    };
    let e = gen_pow(rng, d);
    if prefix.is_empty() {
        e
    } else {
        format!("{prefix}{e}")
    }
}

fn gen_pow(rng: &mut Rng, d: u32) -> String {
    let mut e = gen_term(rng, d);
    while d > 0 && rng.chance(10) {
        e += " ^ ";
        e += &gen_term(rng, d - 1);
    }
    e
}

fn gen_term(rng: &mut Rng, d: u32) -> String {
    if d > 0 && rng.chance(25) {
        format!("({})", gen_top(rng, d - 1))
    } else {
        atom(rng)
    }
}

/// Independent recursive evaluator over the generated subset, computing
/// values during a plain recursive-descent parse. It follows the same
/// precedence table and Java-int bitwise semantics the engine ports.
struct RefEval<'a> {
    toks: Vec<String>,
    pos: usize,
    state: &'a ExprState,
}

fn reference_eval(text: &str, state: &ExprState) -> f64 {
    let mut p = RefEval {
        toks: ref_lex(text),
        pos: 0,
        state,
    };
    p.top()
}

fn ref_lex(input: &str) -> Vec<String> {
    let b = input.as_bytes();
    let mut toks = Vec::new();
    let mut i = 0;
    while i < b.len() {
        let c = b[i];
        if c.is_ascii_whitespace() {
            i += 1;
        } else if c.is_ascii_digit() || c == b'.' {
            let start = i;
            while i < b.len() && (b[i].is_ascii_digit() || b[i] == b'.') {
                i += 1;
            }
            toks.push(input[start..i].to_string());
        } else if c.is_ascii_alphabetic() {
            let start = i;
            while i < b.len() && b[i].is_ascii_alphabetic() {
                i += 1;
            }
            toks.push(input[start..i].to_string());
        } else {
            let rest = &input[i..];
            let two = ["||", "&&", ">>", "==", "<=", ">=", "!="]
                .iter()
                .find(|op| rest.starts_with(*op))
                .copied();
            match two {
                Some(op) => {
                    toks.push(op.to_string());
                    i += 2;
                }
                None => {
                    toks.push((c as char).to_string());
                    i += 1;
                }
            }
        }
    }
    toks
}

fn as_int(v: f64) -> i32 {
    (v.trunc() as i64) as i32
}

impl<'a> RefEval<'a> {
    fn peek(&self) -> Option<&String> {
        self.toks.get(self.pos)
    }
    fn eat(&mut self, w: &str) -> bool {
        if self.peek().map(|t| t.as_str()) == Some(w) {
            self.pos += 1;
            true
        } else {
            false
        }
    }
    fn var(&self, w: &str) -> f64 {
        let b = w.as_bytes();
        if w == "t" {
            self.state.t
        } else {
            self.state.values[(b[0] - b'a') as usize]
        }
    }
    fn top(&mut self) -> f64 {
        let cond = self.or_level();
        if self.eat("?") {
            let a = self.or_level();
            assert!(self.eat(":"));
            let b = self.top();
            if cond != 0.0 {
                a
            } else {
                b
            }
        } else {
            cond
        }
    }
    fn or_level(&mut self) -> f64 {
        let mut e = self.and_level();
        while self.eat("||") {
            let r = self.and_level();
            e = if e != 0.0 || r != 0.0 { 1.0 } else { 0.0 };
        }
        e
    }
    fn and_level(&mut self) -> f64 {
        let mut e = self.bit_or_level();
        while self.eat("&&") {
            let r = self.bit_or_level();
            e = if e != 0.0 && r != 0.0 { 1.0 } else { 0.0 };
        }
        e
    }
    fn bit_or_level(&mut self) -> f64 {
        let mut e = self.bit_and_level();
        while self.eat("|") {
            let r = self.bit_and_level();
            e = (as_int(e) | as_int(r)) as f64;
        }
        e
    }
    fn bit_and_level(&mut self) -> f64 {
        let mut e = self.eq_level();
        while self.eat("&") {
            let r = self.eq_level();
            e = (as_int(e) & as_int(r)) as f64;
        }
        e
    }
    fn eq_level(&mut self) -> f64 {
        let e = self.cmp_level();
        if self.eat("==") {
            let r = self.cmp_level();
            (e == r) as i32 as f64
        } else {
            e
        }
    }
    fn cmp_level(&mut self) -> f64 {
        let e = self.shift_level();
        for op in ["<=", ">=", "!=", "<", ">"] {
            if self.eat(op) {
                let r = self.shift_level();
                return match op {
                    "<=" => e <= r,
                    ">=" => e >= r,
                    "!=" => e != r,
                    "<" => e < r,
                    _ => e > r,
                } as i32 as f64;
            }
        }
        e
    }
    fn shift_level(&mut self) -> f64 {
        let mut e = self.add_level();
        while self.eat(">>") {
            let r = self.add_level();
            e = (as_int(e) >> (as_int(r) & 31)) as f64;
        }
        e
    }
    fn add_level(&mut self) -> f64 {
        let mut e = self.mult_level();
        loop {
            if self.eat("+") {
                e += self.mult_level();
            } else if self.eat("-") {
                e -= self.mult_level();
            } else {
                return e;
            }
        }
    }
    fn mult_level(&mut self) -> f64 {
        let mut e = self.unary_level();
        loop {
            if self.eat("*") {
                e *= self.unary_level();
            } else if self.eat("/") {
                e /= self.unary_level();
            } else if self.eat("%") {
                e %= self.unary_level();
            } else {
                return e;
            }
        }
    }
    fn unary_level(&mut self) -> f64 {
        self.eat("+");
        if self.eat("!") {
            let e = self.unary_level();
            return if e == 0.0 { 1.0 } else { 0.0 };
        }
        if self.eat("-") {
            return -self.unary_level();
        }
        self.pow_level()
    }
    fn pow_level(&mut self) -> f64 {
        let mut e = self.term();
        while self.eat("^") {
            e = e.powf(self.term());
        }
        e
    }
    fn term(&mut self) -> f64 {
        if self.eat("(") {
            let e = self.top();
            assert!(self.eat(")"));
            return e;
        }
        match self.toks.get(self.pos) {
            Some(t) => {
                self.pos += 1;
                match t.parse::<f64>() {
                    Ok(v) => v,
                    Err(_) => self.var(t),
                }
            }
            None => panic!("reference evaluator ran off the end"),
        }
    }
}
