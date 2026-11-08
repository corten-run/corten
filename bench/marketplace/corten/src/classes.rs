//! Typed names from the fixed, external benchmark stylesheet (which must not be scoped).
use corten::style::ClassList;
pub enum Class {
    Root,
    Categories,
    Subtitle,
    Badges,
    Images,
    Image,
    Summary,
    Listings,
    Offers,
    More,
    Alert,
    Message,
    Details,
    Contents,
    Included,
}
impl ClassList for Class {
    fn write_classes(&self, out: &mut String) {
        out.push_str(match self {
            Self::Root => "marketplace",
            Self::Categories => "marketplace__categories",
            Self::Subtitle => "marketplace__subtitle",
            Self::Badges => "marketplace__badges",
            Self::Images => "marketplace__images",
            Self::Image => "marketplace__image",
            Self::Summary => "marketplace__summary",
            Self::Listings => "marketplace__listings",
            Self::Offers => "marketplace__offers",
            Self::More => "marketplace__more",
            Self::Alert => "marketplace__alert",
            Self::Message => "marketplace__message",
            Self::Details => "marketplace__details",
            Self::Contents => "marketplace__contents",
            Self::Included => "marketplace__included",
        });
        out.push(' ');
    }
}
