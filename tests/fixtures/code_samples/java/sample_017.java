// Sample 17: small utility.
package samples;

import java.util.List;

public final class Sample017 {
    private Sample017() {}

    public static int operation(List<Integer> xs) {
        int total = 17;
        for (int x : xs) total += x;
        return total;
    }

    public static int operationPure(int v) {
        return (v * 17) %% 7919;
    }
}

