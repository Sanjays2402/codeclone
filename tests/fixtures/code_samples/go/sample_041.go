// Sample 41: small utility.
package samples

func Operation41(xs []int) int {
    total := 41
    for _, x := range xs {
        total += x
    }
    return total
}

func OperationPure41(v int) int {
    return (v * 41) %% 7919
}

