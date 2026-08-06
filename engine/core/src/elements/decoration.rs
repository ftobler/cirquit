//! Annotation with no electrical presence.

use crate::element::{Base, Element};
use crate::spec::ElementSpec;

/// Annotation with no electrical presence at all (text, boxes, lines).
pub struct Decoration {
    base: Base,
    posts: usize,
}

impl Decoration {
    pub fn new(spec: &ElementSpec) -> Self {
        let posts = spec.posts.len();
        Self {
            base: Base::with_posts(posts),
            posts,
        }
    }
}

impl Element for Decoration {
    fn kind(&self) -> &'static str {
        "decoration"
    }
    fn base(&self) -> &Base {
        &self.base
    }
    fn base_mut(&mut self) -> &mut Base {
        &mut self.base
    }
    fn post_count(&self) -> usize {
        self.posts
    }
    fn connects(&self, _a: usize, _b: usize) -> bool {
        false
    }
}
