//! Recursive-descent expression evaluator, the port of upstream's
//! `ExprParser`/`Expr` (Expr.java). The VCVS and VCCS elements evaluate their
//! value string with this on every Newton iteration, so it stays decoupled
//! from the matrix machinery: the only context an expression sees is an
//! [`ExprState`] of the nine input values, their previous-step snapshots, the
//! last output and the clock.
//!
//! Grammar: numbers, variables `a`..`i`, `t`, `pi`, `e`, `lastoutput`,
//! `timestep`, `lasta`..`lasti`, `da`..`di` (written `dadt`, `dcdt`, ...),
//! unary `+ - !`, binary `+ - * / ^ %`, bitwise `& | >>`, logical `&& ||`,
//! comparisons `== != < > <= >=`, ternary `? :`, and the functions
//! `sin cos tan asin acos atan sinh cosh tanh abs exp log sqrt floor ceil tri
//! saw min max pwl mod step select clamp pwr pwrs`.

/// Values an expression evaluates against: the nine input slots, their
/// previous-step snapshots, the last output and the clock.
///
/// The `e` constant lives in `values[4]` at construction, exactly where
/// upstream seeds it (ExprState constructor, Expr.java:11-16), so a bare `e`
/// in an expression reads it back.
pub struct ExprState {
    /// The nine input values, `a`..`i`.
    pub values: [f64; 9],
    /// The values from the previous step, feeding `lasta`..`lasti` and
    /// `da`..`di`.
    pub last_values: [f64; 9],
    /// The element's output on the previous step, for `lastoutput`.
    pub last_output: f64,
    /// Simulated time, for `t`.
    pub t: f64,
    /// Step length feeding `timestep` and the `da`..`di` derivatives. Kept on
    /// the state so the evaluator stays decoupled from the simulation context.
    pub time_step: f64,
}

impl ExprState {
    pub fn new() -> Self {
        let mut values = [0.0; 9];
        values[4] = std::f64::consts::E;
        Self {
            values,
            last_values: [0.0; 9],
            last_output: 0.0,
            t: 0.0,
            time_step: 0.0,
        }
    }

    /// Snapshots the current values for the next step's `lasta`..`lasti` and
    /// `da`..`di`, plus the element's output for `lastoutput`
    /// (ExprState.updateLastValues, Expr.java:18-23).
    pub fn update_last_values(&mut self, last_output: f64) {
        self.last_output = last_output;
        self.last_values = self.values;
    }

    /// Zeroes the previous-step values, upstream's ExprState.reset, used on
    /// circuit reset (Expr.java:25-30). The live values and the `e` seed
    /// survive.
    pub fn reset(&mut self) {
        self.last_values = [0.0; 9];
        self.last_output = 0.0;
    }
}

impl Default for ExprState {
    fn default() -> Self {
        Self::new()
    }
}

/// A parsed expression tree. Nodes carry an opcode and a small child list,
/// the same shape the reference implementation uses (children, Expr.java:182).
#[derive(Debug)]
pub struct Expr {
    op: Op,
    children: Vec<Expr>,
}

#[derive(Clone, Copy, Debug)]
enum Op {
    Constant(f64),
    Variable(usize),
    LastVariable(usize),
    Derivative(usize),
    Time,
    LastOutput,
    TimeStep,
    Un(Un),
    Bin(Bin),
    Ternary,
    Func(Func),
}

/// Unary operators, whose children hold a single operand.
#[derive(Clone, Copy, Debug)]
enum Un {
    Negate,
    Not,
}

/// Binary operators, in increasing binding order: the parser builds a tree
/// with `*`/`/`/`^` deeper than `+`/`-`, matching upstream's precedence
/// (Expr.java:390-434).
#[derive(Clone, Copy, Debug)]
enum Bin {
    Add,
    Sub,
    Mul,
    Div,
    Pow,
    Mod,
    BitAnd,
    BitOr,
    Shift,
    And,
    Or,
    Eq,
    Ne,
    Lt,
    Le,
    Gt,
    Ge,
}

/// Function-call opcodes. `Min`, `Max` and `Pwl` are variadic; `Step` takes
/// one or two arguments; the rest take a fixed arity.
#[derive(Clone, Copy, Debug)]
enum Func {
    Sin,
    Cos,
    Tan,
    Asin,
    Acos,
    Atan,
    Sinh,
    Cosh,
    Tanh,
    Abs,
    Exp,
    Log,
    Sqrt,
    Floor,
    Ceil,
    Triangle,
    Sawtooth,
    Mod,
    Min,
    Max,
    Pwl,
    Step,
    Select,
    Clamp,
    Pwr,
    Pwrs,
}

impl Expr {
    fn constant(v: f64) -> Self {
        Self {
            op: Op::Constant(v),
            children: Vec::new(),
        }
    }
    fn time() -> Self {
        Self {
            op: Op::Time,
            children: Vec::new(),
        }
    }
    fn last_output() -> Self {
        Self {
            op: Op::LastOutput,
            children: Vec::new(),
        }
    }
    fn time_step() -> Self {
        Self {
            op: Op::TimeStep,
            children: Vec::new(),
        }
    }
    fn variable(i: usize) -> Self {
        Self {
            op: Op::Variable(i),
            children: Vec::new(),
        }
    }
    fn last_variable(i: usize) -> Self {
        Self {
            op: Op::LastVariable(i),
            children: Vec::new(),
        }
    }
    fn derivative(i: usize) -> Self {
        Self {
            op: Op::Derivative(i),
            children: Vec::new(),
        }
    }
    fn unary(op: Un, a: Expr) -> Self {
        Self {
            op: Op::Un(op),
            children: vec![a],
        }
    }
    fn binary(op: Bin, a: Expr, b: Expr) -> Self {
        Self {
            op: Op::Bin(op),
            children: vec![a, b],
        }
    }
    fn ternary(cond: Expr, a: Expr, b: Expr) -> Self {
        Self {
            op: Op::Ternary,
            children: vec![cond, a, b],
        }
    }
    fn func(f: Func, children: Vec<Expr>) -> Self {
        Self {
            op: Op::Func(f),
            children,
        }
    }

    /// Evaluates the tree against `state`, following the reference `eval`
    /// switch for every opcode (Expr.java:47-152).
    pub fn eval(&self, state: &ExprState) -> f64 {
        match self.op {
            Op::Constant(v) => v,
            Op::Variable(i) => state.values[i],
            Op::LastVariable(i) => state.last_values[i],
            // Upstream divides by SimulationManager.theSim.timeStep; the port
            // carries the same value on the state so the evaluator needs no
            // wider context (Expr.java:145-146).
            Op::Derivative(i) => (state.values[i] - state.last_values[i]) / state.time_step,
            Op::Time => state.t,
            Op::LastOutput => state.last_output,
            Op::TimeStep => state.time_step,
            Op::Un(op) => {
                let a = self.children[0].eval(state);
                match op {
                    Un::Negate => -a,
                    Un::Not => {
                        if a == 0.0 {
                            1.0
                        } else {
                            0.0
                        }
                    }
                }
            }
            Op::Bin(op) => {
                let a = self.children[0].eval(state);
                let b = self.children[1].eval(state);
                match op {
                    Bin::Add => a + b,
                    Bin::Sub => a - b,
                    Bin::Mul => a * b,
                    Bin::Div => a / b,
                    Bin::Pow => a.powf(b),
                    Bin::Mod => a % b,
                    Bin::BitAnd => (as_int(a) & as_int(b)) as f64,
                    Bin::BitOr => (as_int(a) | as_int(b)) as f64,
                    Bin::Shift => (as_int(a) >> as_int(b)) as f64,
                    Bin::And => {
                        if a != 0.0 && b != 0.0 {
                            1.0
                        } else {
                            0.0
                        }
                    }
                    Bin::Or => {
                        if a != 0.0 || b != 0.0 {
                            1.0
                        } else {
                            0.0
                        }
                    }
                    Bin::Eq => {
                        if a == b {
                            1.0
                        } else {
                            0.0
                        }
                    }
                    Bin::Ne => {
                        if a != b {
                            1.0
                        } else {
                            0.0
                        }
                    }
                    Bin::Lt => {
                        if a < b {
                            1.0
                        } else {
                            0.0
                        }
                    }
                    Bin::Le => {
                        if a <= b {
                            1.0
                        } else {
                            0.0
                        }
                    }
                    Bin::Gt => {
                        if a > b {
                            1.0
                        } else {
                            0.0
                        }
                    }
                    Bin::Ge => {
                        if a >= b {
                            1.0
                        } else {
                            0.0
                        }
                    }
                }
            }
            Op::Ternary => {
                if self.children[0].eval(state) != 0.0 {
                    self.children[1].eval(state)
                } else {
                    self.children[2].eval(state)
                }
            }
            Op::Func(f) => {
                let c = &self.children;
                match f {
                    Func::Sin => c[0].eval(state).sin(),
                    Func::Cos => c[0].eval(state).cos(),
                    Func::Tan => c[0].eval(state).tan(),
                    Func::Asin => c[0].eval(state).asin(),
                    Func::Acos => c[0].eval(state).acos(),
                    Func::Atan => c[0].eval(state).atan(),
                    Func::Sinh => c[0].eval(state).sinh(),
                    Func::Cosh => c[0].eval(state).cosh(),
                    Func::Tanh => c[0].eval(state).tanh(),
                    Func::Abs => c[0].eval(state).abs(),
                    Func::Exp => c[0].eval(state).exp(),
                    // Upstream's Math.log is the natural logarithm
                    // (Expr.java:78).
                    Func::Log => c[0].eval(state).ln(),
                    Func::Sqrt => c[0].eval(state).sqrt(),
                    Func::Floor => c[0].eval(state).floor(),
                    Func::Ceil => c[0].eval(state).ceil(),
                    Func::Triangle => {
                        let x =
                            posmod(c[0].eval(state), std::f64::consts::TAU) / std::f64::consts::PI;
                        if x < 1.0 {
                            -1.0 + 2.0 * x
                        } else {
                            3.0 - 2.0 * x
                        }
                    }
                    Func::Sawtooth => {
                        posmod(c[0].eval(state), std::f64::consts::TAU) / std::f64::consts::PI - 1.0
                    }
                    Func::Mod => c[0].eval(state) % c[1].eval(state),
                    Func::Min => {
                        let mut x = c[0].eval(state);
                        for ch in &c[1..] {
                            x = x.min(ch.eval(state));
                        }
                        x
                    }
                    Func::Max => {
                        let mut x = c[0].eval(state);
                        for ch in &c[1..] {
                            x = x.max(ch.eval(state));
                        }
                        x
                    }
                    Func::Pwl => self.pwl(state),
                    Func::Step => {
                        let x = c[0].eval(state);
                        if c.len() == 1 {
                            if x < 0.0 {
                                0.0
                            } else {
                                1.0
                            }
                        } else {
                            let thr = c[1].eval(state);
                            // The reference returns 0 both above the threshold
                            // and below zero (Expr.java:110-113).
                            if x > thr || x < 0.0 {
                                0.0
                            } else {
                                1.0
                            }
                        }
                    }
                    // select(x, y, z) is z when x > 0 and y otherwise
                    // (Expr.java:114-117).
                    Func::Select => {
                        let x = c[0].eval(state);
                        if x > 0.0 {
                            c[2].eval(state)
                        } else {
                            c[1].eval(state)
                        }
                    }
                    Func::Clamp => {
                        let v = c[0].eval(state);
                        let lo = c[1].eval(state);
                        let hi = c[2].eval(state);
                        v.max(lo).min(hi)
                    }
                    Func::Pwr => c[0].eval(state).abs().powf(c[1].eval(state)),
                    Func::Pwrs => {
                        let x = c[0].eval(state);
                        let y = c[1].eval(state);
                        if x < 0.0 {
                            -(-x).powf(y)
                        } else {
                            x.powf(y)
                        }
                    }
                }
            }
        }
    }

    /// Piecewise-linear interpolation over `(x0,y0), (x1,y1), ...` segments,
    /// constant before the first abscissa and after the last
    /// (Expr.pwl, Expr.java:154-175).
    fn pwl(&self, state: &ExprState) -> f64 {
        let c = &self.children;
        let x = c[0].eval(state);
        let x0 = c[1].eval(state);
        let y0 = c[2].eval(state);
        if x < x0 {
            return y0;
        }
        if c.len() < 5 {
            // No complete segment to interpolate; hold the first output rather
            // than indexing past the argument list the parser allowed.
            return y0;
        }
        let mut x0 = x0;
        let mut y0 = y0;
        let mut x1 = c[3].eval(state);
        let mut y1 = c[4].eval(state);
        let mut i = 5;
        loop {
            if x < x1 {
                return y0 + (x - x0) * (y1 - y0) / (x1 - x0);
            }
            if i + 1 >= c.len() {
                break;
            }
            x0 = x1;
            y0 = y1;
            x1 = c[i].eval(state);
            y1 = c[i + 1].eval(state);
            i += 2;
        }
        y1
    }
}

/// Java's `(int)` cast on a double: truncate toward zero and wrap into i32
/// range, matching the reference implementation's bitwise operators
/// (Expr.java:87-89).
#[inline]
fn as_int(v: f64) -> i32 {
    (v.trunc() as i64) as i32
}

/// Modulo that never returns negative for a positive modulus, upstream's
/// `posmod` (Expr.java:177-180).
fn posmod(x: f64, y: f64) -> f64 {
    let m = x % y;
    if m >= 0.0 {
        m
    } else {
        m + y
    }
}

/// Parses `input` into an expression tree, lowercasing it first like the
/// upstream constructor (ExprParser, Expr.java:561-567). Returns a parse
/// error message on failure and never panics.
pub fn parse(input: &str) -> Result<Expr, String> {
    let lower = input.to_lowercase();
    let toks = lex(&lower)?;
    let mut p = Parser {
        toks,
        pos: 0,
        err: None,
    };
    let e = p.parse_expr();
    match p.err {
        Some(err) => Err(err),
        None => Ok(e),
    }
}

#[derive(Debug, Clone)]
enum Tok {
    Num(f64),
    Word(String),
}

/// Tokenises the input into numbers, whole words and single or double
/// operator symbols. The doubled-operator set matches upstream's lexer
/// (Expr.java:274-281): `|| && >> << == <= >= !=`.
fn lex(input: &str) -> Result<Vec<Tok>, String> {
    let bytes = input.as_bytes();
    let mut toks = Vec::new();
    let mut i = 0;
    while i < bytes.len() {
        let c = bytes[i];
        if c.is_ascii_whitespace() {
            i += 1;
            continue;
        }
        if c.is_ascii_digit() || c == b'.' {
            let (v, next) = lex_number(bytes, i)?;
            toks.push(Tok::Num(v));
            i = next;
            continue;
        }
        if c.is_ascii_alphabetic() {
            let start = i;
            while i < bytes.len() && bytes[i].is_ascii_alphabetic() {
                i += 1;
            }
            toks.push(Tok::Word(input[start..i].to_string()));
            continue;
        }
        if c >= 0x80 {
            // Non-ASCII: consume one whole char as an unrecognised token
            // rather than splitting bytes.
            let ch = input[i..].chars().next().unwrap_or_default();
            let w = ch.to_string();
            i += ch.len_utf8();
            toks.push(Tok::Word(w));
            continue;
        }
        let two = i + 1 < bytes.len()
            && ((bytes[i + 1] == c && matches!(c, b'|' | b'&' | b'<' | b'>' | b'='))
                || (matches!(c, b'<' | b'>' | b'!') && bytes[i + 1] == b'='));
        if two {
            toks.push(Tok::Word(input[i..i + 2].to_string()));
            i += 2;
        } else {
            toks.push(Tok::Word(input[i..i + 1].to_string()));
            i += 1;
        }
    }
    Ok(toks)
}

/// Reads a number with an optional `e` exponent at `bytes[start]`.
fn lex_number(bytes: &[u8], start: usize) -> Result<(f64, usize), String> {
    let mut end = start;
    while end < bytes.len() && (bytes[end].is_ascii_digit() || bytes[end] == b'.') {
        end += 1;
    }
    if end < bytes.len() && bytes[end] == b'e' {
        let mut k = end + 1;
        if k < bytes.len() && (bytes[k] == b'+' || bytes[k] == b'-') {
            k += 1;
        }
        if k < bytes.len() && bytes[k].is_ascii_digit() {
            end = k;
            while end < bytes.len() && bytes[end].is_ascii_digit() {
                end += 1;
            }
        }
    }
    let tok = std::str::from_utf8(&bytes[start..end]).unwrap();
    let v = tok
        .parse::<f64>()
        .map_err(|_| format!("invalid number: {tok}"))?;
    Ok((v, end))
}

/// The slot index for a single variable letter `a`..`i`.
fn var_index(w: &str) -> Option<usize> {
    let b = w.as_bytes();
    if b.len() == 1 && (b'a'..=b'i').contains(&b[0]) {
        Some((b[0] - b'a') as usize)
    } else {
        None
    }
}

struct Parser {
    toks: Vec<Tok>,
    pos: usize,
    err: Option<String>,
}

impl Parser {
    fn set_error(&mut self, msg: String) {
        if self.err.is_none() {
            self.err = Some(msg);
        }
    }

    fn peek(&self) -> Option<&Tok> {
        self.toks.get(self.pos)
    }

    /// Consumes the current token when it equals `w`, Java's `skip`
    /// (Expr.java:287-292).
    fn skip_word(&mut self, w: &str) -> bool {
        if matches!(self.peek(), Some(Tok::Word(t)) if t == w) {
            self.pos += 1;
            true
        } else {
            false
        }
    }

    /// Java's `skipOrError`: consumes `w` or records the first parse error
    /// (Expr.java:299-303).
    fn skip_or_error(&mut self, w: &str) {
        if !self.skip_word(w) {
            let got = match self.peek() {
                Some(Tok::Word(t)) => t.clone(),
                Some(Tok::Num(v)) => v.to_string(),
                None => "end of input".to_string(),
            };
            self.set_error(format!("expected {w}, got {got}"));
        }
    }

    fn parse_expr(&mut self) -> Expr {
        if self.peek().is_none() {
            // Empty input evaluates to zero, like upstream's parseExpression
            // when the first token is empty (Expr.java:306-307).
            return Expr::constant(0.0);
        }
        let e = self.parse();
        if let Some(tok) = self.peek() {
            let got = match tok {
                Tok::Num(v) => v.to_string(),
                Tok::Word(w) => w.clone(),
            };
            self.set_error(format!("unexpected token: {got}"));
        }
        e
    }

    /// Top of the grammar, where the ternary sits: `parseOr ? parseOr : parse`
    /// (Expr.java:314-326).
    fn parse(&mut self) -> Expr {
        let cond = self.parse_or();
        if self.skip_word("?") {
            let a = self.parse_or();
            self.skip_or_error(":");
            let b = self.parse();
            Expr::ternary(cond, a, b)
        } else {
            cond
        }
    }

    fn parse_or(&mut self) -> Expr {
        let mut e = self.parse_and();
        while self.skip_word("||") {
            let rhs = self.parse_and();
            e = Expr::binary(Bin::Or, e, rhs);
        }
        e
    }

    fn parse_and(&mut self) -> Expr {
        let mut e = self.parse_bit_or();
        while self.skip_word("&&") {
            let rhs = self.parse_bit_or();
            e = Expr::binary(Bin::And, e, rhs);
        }
        e
    }

    fn parse_bit_or(&mut self) -> Expr {
        let mut e = self.parse_bit_and();
        while self.skip_word("|") {
            let rhs = self.parse_bit_and();
            e = Expr::binary(Bin::BitOr, e, rhs);
        }
        e
    }

    fn parse_bit_and(&mut self) -> Expr {
        let mut e = self.parse_equals();
        while self.skip_word("&") {
            let rhs = self.parse_equals();
            e = Expr::binary(Bin::BitAnd, e, rhs);
        }
        e
    }

    fn parse_equals(&mut self) -> Expr {
        let e = self.parse_compare();
        if self.skip_word("==") {
            let rhs = self.parse_compare();
            Expr::binary(Bin::Eq, e, rhs)
        } else {
            e
        }
    }

    fn parse_compare(&mut self) -> Expr {
        let e = self.parse_shift();
        if self.skip_word("<=") {
            let rhs = self.parse_shift();
            Expr::binary(Bin::Le, e, rhs)
        } else if self.skip_word(">=") {
            let rhs = self.parse_shift();
            Expr::binary(Bin::Ge, e, rhs)
        } else if self.skip_word("!=") {
            let rhs = self.parse_shift();
            Expr::binary(Bin::Ne, e, rhs)
        } else if self.skip_word("<") {
            let rhs = self.parse_shift();
            Expr::binary(Bin::Lt, e, rhs)
        } else if self.skip_word(">") {
            let rhs = self.parse_shift();
            Expr::binary(Bin::Gt, e, rhs)
        } else {
            e
        }
    }

    fn parse_shift(&mut self) -> Expr {
        let mut e = self.parse_add();
        while self.skip_word(">>") {
            let rhs = self.parse_add();
            e = Expr::binary(Bin::Shift, e, rhs);
        }
        e
    }

    fn parse_add(&mut self) -> Expr {
        let mut e = self.parse_mult();
        loop {
            if self.skip_word("+") {
                let rhs = self.parse_mult();
                e = Expr::binary(Bin::Add, e, rhs);
            } else if self.skip_word("-") {
                let rhs = self.parse_mult();
                e = Expr::binary(Bin::Sub, e, rhs);
            } else {
                break;
            }
        }
        e
    }

    fn parse_mult(&mut self) -> Expr {
        let mut e = self.parse_uminus();
        loop {
            if self.skip_word("*") {
                let rhs = self.parse_uminus();
                e = Expr::binary(Bin::Mul, e, rhs);
            } else if self.skip_word("/") {
                let rhs = self.parse_uminus();
                e = Expr::binary(Bin::Div, e, rhs);
            } else if self.skip_word("%") {
                // Upstream only has `mod(a, b)` as a function; the infix form
                // is a port extension at the same precedence as `*` and `/`.
                let rhs = self.parse_uminus();
                e = Expr::binary(Bin::Mod, e, rhs);
            } else {
                break;
            }
        }
        e
    }

    /// Unary operators bind tighter than `^`, so `-2^2` parses as `-(2^2)`
    /// (Expr.java:416-423). A leading `+` is a no-op.
    fn parse_uminus(&mut self) -> Expr {
        self.skip_word("+");
        if self.skip_word("!") {
            let e = self.parse_uminus();
            Expr::unary(Un::Not, e)
        } else if self.skip_word("-") {
            let e = self.parse_uminus();
            Expr::unary(Un::Negate, e)
        } else {
            self.parse_pow()
        }
    }

    fn parse_pow(&mut self) -> Expr {
        let mut e = self.parse_term();
        while self.skip_word("^") {
            let rhs = self.parse_term();
            e = Expr::binary(Bin::Pow, e, rhs);
        }
        e
    }

    fn parse_func(&mut self, f: Func) -> Expr {
        self.skip_or_error("(");
        let e = self.parse();
        self.skip_or_error(")");
        Expr::func(f, vec![e])
    }

    fn parse_func_multi(&mut self, f: Func, min_args: usize, max_args: usize) -> Expr {
        let mut args = 1;
        self.skip_or_error("(");
        let e1 = self.parse();
        let mut children = vec![e1];
        while self.skip_word(",") {
            children.push(self.parse());
            args += 1;
        }
        self.skip_or_error(")");
        if args < min_args || args > max_args {
            self.set_error(format!("bad number of function args: {args}"));
        }
        Expr::func(f, children)
    }

    /// A primary term: a parenthesised expression, `t`, a variable, a
    /// `lastx`/`dxdt` form, a keyword, a function call, or a number. The
    /// checks run in upstream's order, which matters because `t`, the single
    /// letters and the `last...` prefix all start with the same characters
    /// (Expr.java:459-559).
    fn parse_term(&mut self) -> Expr {
        if self.skip_word("(") {
            let e = self.parse();
            self.skip_or_error(")");
            return e;
        }
        if self.skip_word("t") {
            return Expr::time();
        }
        match self.peek() {
            Some(Tok::Num(v)) => {
                let v = *v;
                self.pos += 1;
                Expr::constant(v)
            }
            Some(Tok::Word(w)) => {
                let w = w.clone();
                self.pos += 1;
                if w.len() == 1 {
                    if let Some(i) = var_index(&w) {
                        return Expr::variable(i);
                    }
                }
                if w.len() == 5 && w.starts_with("last") {
                    if let Some(i) = var_index(&w[4..]) {
                        return Expr::last_variable(i);
                    }
                }
                // The derivative form is `d` + letter + `dt`, e.g. `dadt`
                // (Expr.java:481-487).
                if w.len() == 4 && w.starts_with('d') && w.ends_with("dt") {
                    if let Some(i) = var_index(&w[1..2]) {
                        return Expr::derivative(i);
                    }
                }
                match w.as_str() {
                    "lastoutput" => Expr::last_output(),
                    "timestep" => Expr::time_step(),
                    "pi" => Expr::constant(std::f64::consts::PI),
                    "sin" => self.parse_func(Func::Sin),
                    "cos" => self.parse_func(Func::Cos),
                    "tan" => self.parse_func(Func::Tan),
                    "asin" => self.parse_func(Func::Asin),
                    "acos" => self.parse_func(Func::Acos),
                    "atan" => self.parse_func(Func::Atan),
                    "sinh" => self.parse_func(Func::Sinh),
                    "cosh" => self.parse_func(Func::Cosh),
                    "tanh" => self.parse_func(Func::Tanh),
                    "abs" => self.parse_func(Func::Abs),
                    "exp" => self.parse_func(Func::Exp),
                    "log" => self.parse_func(Func::Log),
                    "sqrt" => self.parse_func(Func::Sqrt),
                    "floor" => self.parse_func(Func::Floor),
                    "ceil" => self.parse_func(Func::Ceil),
                    "tri" => self.parse_func(Func::Triangle),
                    "saw" => self.parse_func(Func::Sawtooth),
                    "min" => self.parse_func_multi(Func::Min, 2, 1000),
                    "max" => self.parse_func_multi(Func::Max, 2, 1000),
                    "pwl" => self.parse_func_multi(Func::Pwl, 2, 1000),
                    "mod" => self.parse_func_multi(Func::Mod, 2, 2),
                    "step" => self.parse_func_multi(Func::Step, 1, 2),
                    "select" => self.parse_func_multi(Func::Select, 3, 3),
                    "clamp" => self.parse_func_multi(Func::Clamp, 3, 3),
                    "pwr" => self.parse_func_multi(Func::Pwr, 2, 2),
                    "pwrs" => self.parse_func_multi(Func::Pwrs, 2, 2),
                    _ => {
                        self.set_error(format!("unrecognized token: {w}"));
                        Expr::constant(0.0)
                    }
                }
            }
            None => {
                self.set_error("unexpected end of input".to_string());
                Expr::constant(0.0)
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
}
